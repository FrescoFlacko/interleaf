"""Real ESLint runs of the architecture boundary bans; lints text in memory, writes nothing."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
BOUNDARY_RULES = {"no-restricted-syntax", "@typescript-eslint/no-restricted-imports"}
LINT_TEXTS = """
const { ESLint } = await import(process.cwd() + '/node_modules/eslint/lib/api.js');
const eslint = new ESLint();
const probes = JSON.parse(process.argv[1]);
const out = [];
for (const [filePath, text] of probes) {
  const [result] = await eslint.lintText(text, { filePath });
  out.push(result.messages.map((m) => m.ruleId ?? `parse: ${m.message}`));
}
process.stdout.write(JSON.stringify(out));
"""

MAIN = "src/main/ipc/dispatcher.ts"
RENDERER = "src/renderer/main.tsx"
PATH_FORMS = [
    "import { relative } from 'node:path'; export const r = relative('a', 'b');",
    "import path from 'node:path'; export const r = path.relative('a', 'b');",
    "import * as paths from 'node:path'; export const r = paths.relative('a', 'b');",
    "import { win32 } from 'node:path'; export const r = win32.relative('a', 'b');",
    "export async function f(): Promise<string> { const p = await import('node:path'); return p.relative('a', 'b'); }",
    "import path from 'node:path'; const { relative: rel } = path; export const r = rel('a', 'b');",
    "import path from 'node:path'; export const r = path['relative']('a', 'b');",
    "import path from 'node:path'; const rel = path.relative; export const r = rel('a', 'b');",
    "import path from 'node:path'; const { ['relative']: rel } = path; export const r = rel('a', 'b');",
    # Receiver-agnostic by design: an unrelated `relative` member is reserved too.
    "const helper = { relative: (a: string) => a }; export const r = helper.relative('a');",
]
PROCESS_FORMS = [
    "import { execFile } from 'node:child_process'; export const e = execFile;",
    "import { spawn } from 'child_process'; export const s = spawn;",
    "export async function f(): Promise<object> { return import('node:child_process'); }",
]
UNSAFE_TYPE_FORMS = [
    "export type Loose = any;",
    "export type Opaque = unknown;",
]
BRIDGE_FORMS = [
    "export const api = window.interleafAPI;",
    "export const api = globalThis.interleafAPI;",
    "const w = window; export const api = w.interleafAPI;",
    "export const api = window['interleafAPI'];",
    "const { interleafAPI } = window; export const api = interleafAPI;",
]


@unittest.skipUnless((ROOT / "node_modules/eslint").is_dir() and shutil.which("node"), "ESLint not installed")
class BoundaryBanTests(unittest.TestCase):
    def lint(self, probes):
        completed = subprocess.run(["node", "--input-type=module", "-e", LINT_TEXTS, json.dumps(probes)],
                                   cwd=ROOT, capture_output=True, text=True, timeout=300, check=True)
        results = json.loads(completed.stdout)
        for rules in results:
            self.assertFalse([r for r in rules if r.startswith("parse:")], rules)
        return [bool(BOUNDARY_RULES & set(rules)) for rules in results]

    def test_bans_catch_direct_aliased_computed_and_dynamic_forms_and_spare_sanctioned_homes(self):
        cases = ([(MAIN, text, True) for text in PATH_FORMS + PROCESS_FORMS]
                 + [(RENDERER, text, True) for text in BRIDGE_FORMS]
                 + [("src/main/security/path-guard.ts", text, False) for text in PATH_FORMS]
                 + [("src/main/agents/process-runner.ts", text, False) for text in PROCESS_FORMS]
                 + [("src/main/agents/process-runner.ts", PATH_FORMS[0], True)]
                 + [("src/renderer/app/api-client.ts", text, False) for text in BRIDGE_FORMS]
                 + [("src/renderer/stores/chat-pre-send-drafts.ts", text, True) for text in BRIDGE_FORMS]
                 + [(MAIN, "import type { ChildProcess } from 'node:child_process'; export type C = ChildProcess;", False)]
                 # No file outside a sanctioned home is exempt.
                 + [("src/main/agents/agent-adapter.ts", PROCESS_FORMS[0], True),
                    ("src/main/agents/agent-adapter.ts", PATH_FORMS[0], True)]
                 # Boundary exemptions never lift the explicit any/unknown ban.
                 + [(path, text, True) for path in (MAIN, RENDERER, "src/main/security/path-guard.ts",
                                                    "src/main/agents/process-runner.ts",
                                                    "src/main/agents/agent-adapter.ts",
                                                    "src/renderer/app/api-client.ts")
                    for text in UNSAFE_TYPE_FORMS])
        flagged = self.lint([[path, text] for path, text, _ in cases])
        for (path, text, expected), actual in zip(cases, flagged, strict=True):
            with self.subTest(path=path, text=text):
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
