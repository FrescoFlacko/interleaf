"""Executable policy regressions; no model calls or project-file edits."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/quality"
sys.path.insert(0, str(SCRIPT))
import gate
from policy import compare, lint_counts, scanner_rows

REDESIGN_FOLDERS = ("AI Chat UI Redesign", "AI Chat UI Redesign (1)", "AI Chat UI Redesign (2)",
                    "AI Chat UI Redesign (5)")


def snapshot(grade="B"):
    row = {"relativePath": "src/a.ts", "grade": grade, "scannerErrors": 0, "issues": [],
           "cognitive": 4, "cyclomatic": 4, "security": 0, "maintainability": 0, "cleanliness": 0}
    return {"schema": 1, "identity": {"configuration": "frozen"}, "files": {"src/a.ts": "old"},
            "suppressions": {}, "lines": {"src/a.ts": 10}, "lint": [{"errorCount": 0, "warningCount": 0, "messages": []}],
            "scanner": {"report": [row], "totals": {"scannerErrors": 0}}}


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.before = snapshot()
        self.after = copy.deepcopy(self.before)
        self.after["files"]["src/a.ts"] = "edited"

    def test_clean_edit_passes(self):
        self.assertTrue(compare(self.before, self.after)["passed"])

    def test_warning_and_error_each_fail(self):
        for severity, key in ((1, "warningCount"), (2, "errorCount")):
            with self.subTest(severity=severity):
                candidate = copy.deepcopy(self.after)
                candidate["lint"][0][key] = 1
                candidate["lint"][0]["messages"] = [{"severity": severity}]
                self.assertFalse(compare(self.before, candidate)["passed"])

    def test_grade_drop_even_outside_poor_group_fails(self):
        self.after["scanner"]["report"][0]["grade"] = "C"
        self.assertEqual(compare(self.before, self.after)["summary"]["grade_decreases"], 1)

    def test_unchanged_poor_file_is_allowed(self):
        before = snapshot("D")
        after = copy.deepcopy(before)
        after["files"]["src/a.ts"] = "edited"
        result = compare(before, after)
        self.assertTrue(result["passed"])
        self.assertEqual(result["summary"]["edited_poor"], 1)

    def test_each_worsening_metric_fails_without_letter_change(self):
        for key in ("cognitive", "cyclomatic", "security", "maintainability", "cleanliness"):
            with self.subTest(metric=key):
                after = copy.deepcopy(self.after)
                after["scanner"]["report"][0][key] += 1
                self.assertFalse(compare(self.before, after)["passed"])

    def test_new_issue_fails_even_if_old_issue_resolved(self):
        issue = {"rule": "rule-a", "category": "maintainability", "message": "old", "count": 1, "line": 2}
        self.before["scanner"]["report"][0]["issues"] = [issue]
        self.after["scanner"]["report"][0]["issues"] = [{**issue, "message": "new"}]
        self.assertFalse(compare(self.before, self.after)["passed"])

    def test_line_movement_does_not_introduce_issue(self):
        issue = {"rule": "rule-a", "category": "maintainability", "message": "same", "count": 1, "line": 2}
        self.before["scanner"]["report"][0]["issues"] = [issue]
        self.after["scanner"]["report"][0]["issues"] = [{**issue, "line": 10}]
        self.assertTrue(compare(self.before, self.after)["passed"])

    def test_new_poor_file_fails_and_new_good_file_passes(self):
        for grade in "ABCDF":
            with self.subTest(grade=grade):
                after = copy.deepcopy(self.after)
                after["files"]["src/new.ts"] = "new"
                after["lines"]["src/new.ts"] = 10
                after["scanner"]["report"].append({**after["scanner"]["report"][0], "relativePath": "src/new.ts", "grade": grade})
                self.assertEqual(compare(self.before, after)["passed"], grade not in "DF")

    def grown(self, before_lines, after_lines, path="src/a.ts"):
        before, after = copy.deepcopy(self.before), copy.deepcopy(self.after)
        for snap, count in ((before, before_lines), (after, after_lines)):
            if count is None:
                snap["files"].pop(path, None)
                snap["lines"].pop(path, None)
                snap["scanner"]["report"] = [r for r in snap["scanner"]["report"] if r["relativePath"] != path]
            else:
                snap["files"][path] = f"v{count}"
                snap["lines"][path] = count
                if path != "src/a.ts":
                    snap["scanner"]["report"].append({**snap["scanner"]["report"][0], "relativePath": path})
        return compare(before, after)

    def test_oversized_file_may_not_grow(self):
        result = self.grown(900, 901)
        self.assertFalse(result["passed"])
        self.assertIn("901 lines exceeds 800 and grew from 900", result["failures"][0])
        self.assertEqual(result["summary"]["oversized_growth"], 1)

    def test_oversized_file_may_shrink_or_stay_and_small_files_may_grow(self):
        for before, after in ((900, 850), (900, 900), (100, 800)):
            with self.subTest(before=before, after=after):
                self.assertTrue(self.grown(before, after)["passed"])

    def test_crossing_the_limit_or_arriving_over_it_fails(self):
        self.assertFalse(self.grown(800, 801)["passed"])
        self.assertFalse(self.grown(None, 801, path="src/new.ts")["passed"])
        self.assertTrue(self.grown(None, 800, path="src/new.ts")["passed"])

    def test_size_limit_applies_only_to_src_sources(self):
        for path in ("tests/big.test.ts", "scripts/big.mjs",
                     "src/renderer/features/reader/adapters/foliate/upstream/big.js"):
            with self.subTest(path=path):
                before, after = copy.deepcopy(self.before), copy.deepcopy(self.after)
                after["files"][path] = "big"
                after["scanner"]["report"].append({**after["scanner"]["report"][0], "relativePath": path})
                self.assertTrue(compare(before, after)["passed"])

    def test_snapshot_without_matching_line_counts_fails_closed(self):
        for mutate in (lambda s: s.pop("lines"), lambda s: s["lines"].clear(),
                       lambda s: s["lines"].update({"src/a.ts": -1})):
            with self.subTest(mutate=mutate):
                before = copy.deepcopy(self.before)
                mutate(before)
                with self.assertRaises(ValueError):
                    compare(before, self.after)

    def test_line_counts_cover_only_src_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative, text in (("src/a.ts", "a\nb\nc"), ("src/b.tsx", ""), ("src/c.css", "x\n"),
                                   ("tests/d.ts", "x\n")):
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_text(text)
            files, _ = gate.inventory(root)
            self.assertEqual(gate.line_counts(root, files), {"src/a.ts": 3, "src/b.tsx": 0})

    def test_deleted_files_are_reported(self):
        before = copy.deepcopy(self.before)
        before["files"]["src/deleted.ts"] = "deleted"
        before["lines"]["src/deleted.ts"] = 10
        before["scanner"]["report"].append({**before["scanner"]["report"][0], "relativePath": "src/deleted.ts"})
        self.assertIn("deleted", [r["kind"] for r in compare(before, self.after)["files"]])

    def test_missing_supported_file_fails(self):
        self.after["files"]["src/untracked.ts"] = "untracked"
        with self.assertRaisesRegex(ValueError, "not scanned"):
            compare(self.before, self.after)

    def test_unsupported_file_is_explicitly_not_assessed(self):
        self.after["files"]["README.md"] = "new"
        self.assertEqual(compare(self.before, self.after)["summary"]["unsupported_changed"], ["README.md"])

    def test_scanner_errors_fail(self):
        self.after["scanner"]["report"][0]["scannerErrors"] = 1
        with self.assertRaisesRegex(ValueError, "analysis failed"):
            compare(self.before, self.after)

    def test_invalid_grade_and_metrics_fail(self):
        for key, value in (("grade", ""), ("cognitive", float("nan")), ("security", -1), ("issues", None)):
            with self.subTest(key=key):
                after = copy.deepcopy(self.after)
                after["scanner"]["report"][0][key] = value
                with self.assertRaises(ValueError):
                    compare(self.before, after)

    def test_tool_or_config_drift_fails(self):
        self.after["identity"]["configuration"] = "changed"
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            compare(self.before, self.after)

    def test_added_suppression_fails(self):
        self.after["suppressions"]["src/a.ts"] = ["// eslint-disable-next-line"]
        self.assertFalse(compare(self.before, self.after)["passed"])

    def test_new_violation_under_existing_suppression_fails(self):
        self.before["root"] = self.after["root"] = "/project"
        self.after["lint"][0].update(filePath="/project/src/a.ts", suppressedMessages=[
            {"ruleId": "no-undef", "severity": 2, "message": "missing is not defined"}])
        self.assertFalse(compare(self.before, self.after)["passed"])

    def test_empty_lint_or_scanner_reports_fail(self):
        with self.assertRaises(ValueError):
            lint_counts([])
        with self.assertRaises(ValueError):
            scanner_rows({"report": []}, {})

    def test_metrics_on_unchanged_file_are_also_checked(self):
        self.after["files"] = self.before["files"].copy()
        self.after["scanner"]["report"][0]["cognitive"] += 1
        self.assertFalse(compare(self.before, self.after)["passed"])


class ExecutionTests(unittest.TestCase):
    def test_moving_existing_directive_fails(self):
        before = snapshot()
        after = copy.deepcopy(before)
        before["suppressions"]["src/a.ts"] = gate.suppression_inventory("// eslint-disable-next-line no-undef\nmissing();")
        after["files"]["src/a.ts"] = "edited"
        after["suppressions"]["src/a.ts"] = gate.suppression_inventory("newCode();\n// eslint-disable-next-line no-undef\nmissing();")
        self.assertFalse(compare(before, after)["passed"])

    def test_lint_failure_does_not_retain_full_source(self):
        report = [{"errorCount": 1, "warningCount": 0, "messages": [{"severity": 2}],
                   "source": "whole-source-secret-marker", "output": "whole-output-marker"}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            response = subprocess.CompletedProcess([], 1, stdout=json.dumps(report))
            with patch.object(gate.subprocess, "run", return_value=response):
                retained = gate.run_lint(root, root, "node")
            self.assertEqual(retained[0]["errorCount"], 1)
            for artifact in root.iterdir():
                self.assertNotIn("whole-source-secret-marker", artifact.read_text())
                self.assertNotIn("whole-output-marker", artifact.read_text())

    def test_global_and_exported_inline_directives_are_detected(self):
        for directive in ("/* global missingGlobal */", "/* globals missingGlobal:readonly */", "/* exported leaked */"):
            with self.subTest(directive=directive):
                before = snapshot()
                after = copy.deepcopy(before)
                after["files"]["src/a.ts"] = "edited"
                after["suppressions"]["src/a.ts"] = gate.SUPPRESSION.findall(directive)
                self.assertFalse(compare(before, after)["passed"])

    def test_multiline_inline_rule_changes_are_detected(self):
        before = "/* eslint-disable\n   rule-a\n*/"
        after = "/* eslint-disable\n   rule-a, rule-b\n*/"
        self.assertNotEqual(gate.SUPPRESSION.findall(before), gate.SUPPRESSION.findall(after))

    def test_inventory_includes_untracked_but_not_build_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "untracked.ts").write_text("// eslint-disable-next-line\nconst x = 1;\n")
            (root / "out").mkdir()
            (root / "out/generated.js").write_text("ignored")
            for folder in REDESIGN_FOLDERS:
                (root / folder).mkdir()
                (root / folder / "support.js").write_text("reference export")
            files, suppressions = gate.inventory(root)
            self.assertEqual(list(files), ["untracked.ts"])
            self.assertEqual(len(suppressions["untracked.ts"]), 1)

    def test_current_and_legacy_generated_state_folders_are_excluded(self):
        # The brand-named generated state folder is excluded under the current name and
        # the pre-rebrand name; similarly named production paths stay covered.
        covered = ["src/interleaf.ts", "src/main/interleaf/state.ts"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in (".interleaf", ".marginlab"):
                (root / folder).mkdir()
                (root / folder / "generated.ts").write_text("const generated = 1;\n")
            for relative in covered:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("const x = 1;\n")
            files, _ = gate.inventory(root)
            self.assertEqual(sorted(files), sorted(covered))

    def test_only_designated_redesign_exports_are_excluded(self):
        # The designated exports carry generated reference JavaScript; similarly named
        # production paths must stay inside lint, scanner and source-hash coverage.
        covered = ["AI Chat UI Redesign (3)/support.js",
                   "AI Chat UI Redesign (4)/support.js",
                   "AI Chat UI Redesign (6)/support.js",
                   "AI Chat UI Redesign Notes/support.js",
                   "src/renderer/features/chat/AI Chat UI Redesign (2).ts",
                   "src/renderer/features/chat/AI Chat UI Redesign (5).ts",
                   "src/renderer/features/chat/ai-chat-ui-redesign.ts"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in REDESIGN_FOLDERS:
                (root / folder).mkdir()
                (root / folder / "support.js").write_text("reference export")
            for relative in covered:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("const x = 1;\n")
            files, _ = gate.inventory(root)
            self.assertEqual(sorted(files), sorted(covered))

    def test_lint_ignores_match_the_designated_redesign_exports(self):
        # ESLint and the gate must exclude the same exact folders.
        config = (SCRIPT.parents[1] / "eslint.config.mjs").read_text(encoding="utf-8")
        for folder in REDESIGN_FOLDERS:
            with self.subTest(folder=folder):
                self.assertIn(f"'**/{folder}/**',", config)
        for folder in ("AI Chat UI Redesign (3)", "AI Chat UI Redesign (4)",
                       "AI Chat UI Redesign (6)"):
            with self.subTest(folder=folder):
                self.assertNotIn(folder, config)

    def skill_tree(self, root):
        skill = root / ".agents/skills/shadcn"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# skill\n")
        (skill / "run.js").write_text("const x = 1;\n")
        return skill

    def test_cli_skill_aliases_are_recorded_not_followed(self):
        aliases = [".claude/skills/shadcn", ".pi/skills/shadcn", "skills/shadcn"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.skill_tree(root)
            for alias in aliases:
                path = root / alias
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(Path("../" * alias.count("/")) / ".agents/skills/shadcn")
            files, suppressions = gate.inventory(root)
            self.assertEqual(sorted(files), aliases)
            self.assertEqual(suppressions, {})
            before = files["skills/shadcn"]
            (root / "skills/shadcn").unlink()
            (root / "skills/shadcn").symlink_to(root.resolve() / ".agents/skills/shadcn")
            files, _ = gate.inventory(root)
            self.assertNotEqual(files["skills/shadcn"], before)

    def test_directory_symlinks_other_than_skill_aliases_are_rejected(self):
        cases = {"skills/app": "../src",
                 "skills/renamed": "../.agents/skills/shadcn",
                 "docs/shadcn": "../.agents/skills/shadcn",
                 ".claude/skills/nested/shadcn": "../../../.agents/skills/shadcn",
                 ".claude/shadcn": "../.agents/skills/shadcn",
                 "skills/skills": "../.agents/skills"}
        for alias, target in cases.items():
            with self.subTest(alias=alias), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.skill_tree(root)
                (root / "src").mkdir()
                (root / "src/a.ts").write_text("const x = 1;\n")
                path = root / alias
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(target)
                with self.assertRaisesRegex(ValueError, f"Source directory symlink not assessed: {alias}"):
                    gate.inventory(root)

    def test_skill_alias_cannot_reach_outside_through_redirected_tool_directory(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            (Path(outside) / "skills/shadcn").mkdir(parents=True)
            (root / ".agents").symlink_to(outside)
            (root / "skills").mkdir()
            (root / "skills/shadcn").symlink_to("../.agents/skills/shadcn")
            with self.assertRaisesRegex(ValueError, "Source directory symlink not assessed: skills/shadcn"):
                gate.inventory(root)

    def test_external_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.ts").symlink_to(SCRIPT / "gate.py")
            with self.assertRaisesRegex(ValueError, "External source symlink"):
                gate.inventory(root)

    def test_artifacts_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "snapshot.json"
            gate.dump(artifact, {"original": True})
            with self.assertRaises(FileExistsError):
                gate.dump(artifact, {"original": False})
            self.assertEqual(json.loads(artifact.read_text()), {"original": True})

    def test_nonzero_tool_exit_is_not_clean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "exited 7"):
                gate.run([sys.executable, "-c", "raise SystemExit(7)"], root, root, "fake")

    def test_missing_baseline_exits_nonzero(self):
        result = subprocess.run([sys.executable, str(SCRIPT / "gate.py"), "check", "--out", "/unused"], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
