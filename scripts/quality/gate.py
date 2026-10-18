#!/usr/bin/env python3
"""Run repository ESLint and global code-scanner; retain immutable evidence outside the tree."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from policy import compare, lint_counts, require, scanner_rows, sized

# ".marginlab" stays alongside ".interleaf" so pre-rename generated state is still excluded.
SKIP_DIRS = {"node_modules", ".git", ".agents", ".worktrees", ".interleaf", ".marginlab", ".firecrawl",
             "out", "dist", "build", "release", "coverage", "test-results", "playwright-report",
             ".vite", "__pycache__", "AI Chat UI Redesign", "AI Chat UI Redesign (1)",
             "AI Chat UI Redesign (2)", "AI Chat UI Redesign (5)"}
EXCLUDES = [f"**/{name}/**" for name in sorted(SKIP_DIRS)]
# CLI skill directories alias entries of the excluded, tool-owned .agents/skills. Only
# these exact parents may hold directory symlinks, each to its same-named skill; the
# link text is hashed and never followed. Any other directory symlink is rejected.
SKILL_ALIAS_PARENTS = {".claude/skills", ".pi/skills", "skills"}
SKILL_ALIAS_TARGET = ".agents/skills"
SCANNER_FALLBACK = Path.home() / ".nvm/versions/node/v22.18.0/bin/code-scanner"
SUPPRESSION = re.compile(r"/\*\s*(?:eslint|globals?|exported)\b[\s\S]*?\*/|//[ \t]*eslint\b[^\r\n]*")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def dump(path, value):
    # Exclusive create keeps baseline and individual attempt artifacts immutable by default.
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def suppression_inventory(source):
    # Moving a directive can disable checks on a different region of source.
    return [f"{match.start()}:{match.group()}" for match in SUPPRESSION.finditer(source)]


def skill_alias(root, path):
    relative = path.relative_to(root)
    target = path.resolve()
    return (relative.parent.as_posix() in SKILL_ALIAS_PARENTS and target.is_dir()
            and target == root.resolve() / SKILL_ALIAS_TARGET / path.name)


def inventory(root):
    files, suppressions = {}, {}
    for parent, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for directory in dirs:
            path = Path(parent) / directory
            if path.is_symlink():
                relative = path.relative_to(root).as_posix()
                require(skill_alias(root, path), f"Source directory symlink not assessed: {relative}")
                # Recorded, not followed: retargeting an alias is a detected source change.
                files[relative] = hashlib.sha256(f"symlink:{os.readlink(path)}".encode()).hexdigest()
        dirs[:] = [d for d in dirs if not (Path(parent) / d).is_symlink()]
        for name in sorted(names):
            if name == ".DS_Store" or name.startswith(".env") or name.endswith((".tsbuildinfo", ".pyc")):
                continue
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                require(path.resolve().is_relative_to(root), f"External source symlink: {relative}")
            require(path.is_file(), f"Not a regular file: {relative}")
            files[relative] = digest(path)
            if path.suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}:
                suppressions[relative] = suppression_inventory(path.read_text(encoding="utf-8"))
    return files, suppressions


def line_counts(root, files):
    return {p: len((root / p).read_text(encoding="utf-8").splitlines()) for p in files if sized(p)}


def protected(path):
    name = Path(path).name
    return (name in {"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", ".scannerrc.json"}
            or name.startswith(("eslint.config.", ".eslintrc", "tsconfig"))
            or path.startswith("scripts/quality/"))


def run(command, root, output, label, allowed=(0,)):
    with (output / f"{label}.log").open("x") as log:
        result = subprocess.run(command, cwd=root, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, timeout=600, check=False)
    dump(output / f"{label}-command.json", {"argv": command, "exit": result.returncode})
    require(result.returncode in allowed, f"{label} exited {result.returncode}; see {output / (label + '.log')}")
    return result.returncode


def resolve_tools(scanner_arg):
    node = shutil.which("node")
    scanner = scanner_arg or os.environ.get("CODE_SCANNER_BIN") or shutil.which("code-scanner")
    if not scanner and SCANNER_FALLBACK.exists():
        scanner = str(SCANNER_FALLBACK)
    require(node and scanner, "Node/code-scanner missing; set CODE_SCANNER_BIN to the existing scanner JS entry point")
    return str(Path(node).resolve()), Path(scanner).expanduser().resolve(strict=True)


def run_lint(root, output, node):
    # ESLint's JSON formatter embeds whole source files on failures. Never write
    # its raw stdout to an artifact; retain only diagnostics and counts.
    command = [node, str(root / "node_modules/eslint/bin/eslint.js"), ".",
               "--max-warnings", "0", "--format", "json"]
    with (output / "eslint.log").open("x") as log:
        result = subprocess.run(command, cwd=root, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=log, text=True,
                                timeout=600, check=False)
    dump(output / "eslint-command.json", {"argv": command, "exit": result.returncode})
    require(result.returncode in (0, 1), f"ESLint exited {result.returncode}; see {output / 'eslint.log'}")
    report = json.loads(result.stdout)
    counts = lint_counts(report)
    require(result.returncode == (1 if any(counts.values()) else 0), "ESLint exit/report mismatch")
    for row in report:
        row.pop("source", None)
        row.pop("output", None)
    dump(output / "eslint.json", report)
    return report


def identity(root, files, node, scanner):
    scanner_root = scanner.parent.parent
    tool_files = [scanner_root / "package.json"]
    for name in ("bin", "dist"):
        tool_files.extend(p for p in (scanner_root / name).rglob("*") if p.is_file())
    require(len(tool_files) > 1, "Scanner built files missing")
    return {"policy": 1, "excludes": EXCLUDES, "profiles": ["generic"],
            "runner": {p.name: digest(p) for p in sorted(Path(__file__).parent.glob("*.py"))},
            "configuration": {p: h for p, h in files.items() if protected(p)},
            "node": {"path": node, "sha256": digest(Path(node))},
            "eslint": {"package": digest(root / "node_modules/eslint/package.json"),
                       "entry": digest(root / "node_modules/eslint/bin/eslint.js")},
            "scanner": {p.relative_to(scanner_root).as_posix(): digest(p) for p in sorted(set(tool_files))}}


def capture(root, output, scanner_arg):
    files, suppressions = inventory(root)
    node, scanner = resolve_tools(scanner_arg)
    tools_before = identity(root, files, node, scanner)
    lint = run_lint(root, output, node)
    scan_command = [node, str(scanner), ".", "--save-as-json", str(output / "scanner.json")]
    for exclusion in EXCLUDES:
        scan_command.extend(["--exclude", exclusion])
    run(scan_command, root, output, "scanner")
    scanner_report = json.loads((output / "scanner.json").read_text())
    scanner_rows(scanner_report, files)
    meta = scanner_report["meta"]
    require(all(meta.get(k) for k in ("version", "configurationFingerprint", "pluginVersions")), "Missing scanner identity")
    lines = line_counts(root, files)
    files_after, suppressions_after = inventory(root)
    require((files, suppressions) == (files_after, suppressions_after), "Sources changed during measurement; retry on stable source")
    require(tools_before == identity(root, files_after, node, scanner), "Tools changed during measurement")
    tools_before["scanner_metadata"] = {k: meta[k] for k in ("version", "configurationFingerprint", "pluginVersions")}
    tools_before["scanner_options"] = scanner_report["options"]
    return {"schema": 1, "root": str(root), "captured_at": datetime.now(timezone.utc).isoformat(),
            "files": files, "suppressions": suppressions, "lines": lines, "identity": tools_before,
            "lint": lint, "scanner": scanner_report}


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("baseline", "check"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--out", required=True, type=Path, help="New evidence directory OUTSIDE the project")
    parser.add_argument("--baseline", type=Path, help="Frozen baseline snapshot.json (required for check)")
    parser.add_argument("--scanner", help="Existing code-scanner JS entry point; defaults to CODE_SCANNER_BIN/PATH")
    args = parser.parse_args()
    require((args.mode == "check") == (args.baseline is not None), "Use --baseline only and always for check")
    args.root = args.root.expanduser().resolve(strict=True)
    args.out = args.out.expanduser().resolve()
    require(not args.out.is_relative_to(args.root), "Evidence must be outside the project")
    if args.baseline:
        args.baseline = args.baseline.expanduser().resolve(strict=True)
        require(not args.baseline.is_relative_to(args.root), "Baseline must be outside the project")
    return args


def main():
    args = arguments()
    # Read the baseline before running tools; retain its digest in the result.
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None
    baseline_hash = digest(args.baseline) if args.baseline else None
    args.out.mkdir(parents=True, exist_ok=False)
    try:
        current = capture(args.root, args.out, args.scanner)
        dump(args.out / "snapshot.json", current)
        if baseline is None:
            counts = lint_counts(current["lint"])
            require(not any(counts.values()), f"Baseline lint is not clean: {counts}; do not dispatch implementation")
            result = {"passed": True, "mode": "baseline", "lint": counts}
        else:
            require(digest(args.baseline) == baseline_hash, "Baseline changed during measurement")
            require(not any(lint_counts(baseline["lint"]).values()), "Baseline lint is not clean")
            result = compare(baseline, current)
            result.update(baseline=str(args.baseline), baseline_sha256=baseline_hash)
        dump(args.out / "result.json", result)
        print(json.dumps({"passed": result["passed"], "evidence": str(args.out),
                          "lint": result["lint"], "failures": result.get("failures", [])}, indent=2))
        return 0 if result["passed"] else 1
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        dump(args.out / "failure.json", {"passed": False, "error": str(error)})
        raise


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(f"Quality gate FAILED: {error}", file=sys.stderr)
        sys.exit(2)
