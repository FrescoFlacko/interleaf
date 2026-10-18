"""Pure, fail-closed comparisons for the agent-independent quality gate."""

from collections import Counter
from pathlib import Path, PurePosixPath

GRADES = "ABCDF"
METRICS = ("cognitive", "cyclomatic", "security", "maintainability", "cleanliness")
EXTENSIONS = {".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"}
# Size ratchet: a production source file above the limit may shrink or stay put, never grow.
SIZE_SCOPE = "src/"
# Exact audited upstream code (also ESLint-ignored) is replaced wholesale, not edited.
SIZE_EXEMPT = ("src/renderer/features/reader/adapters/foliate/upstream/",)
LINE_LIMIT = 800


def sized(path):
    return (path.startswith(SIZE_SCOPE) and not path.startswith(SIZE_EXEMPT)
            and PurePosixPath(path).suffix in EXTENSIONS)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and 0 <= value < float("inf")


def lint_counts(report):
    require(isinstance(report, list) and report, "Missing/empty ESLint report")
    totals = Counter(errors=0, warnings=0)
    for row in report:
        for key, name in (("errorCount", "errors"), ("warningCount", "warnings")):
            require(type(row.get(key)) is int and row[key] >= 0, "Malformed lint counts")
            totals[name] += row[key]
        require(isinstance(row.get("messages"), list), "Missing ESLint messages")
        for severity, key in ((2, "errorCount"), (1, "warningCount")):
            require(sum(m.get("severity") == severity for m in row["messages"]) == row[key],
                    "Inconsistent ESLint counts")
    return dict(totals)


def scanner_rows(report, files):
    require(isinstance(report.get("report"), list) and report["report"], "Empty scanner report")
    require(report.get("totals", {}).get("scannerErrors") == 0, "Scanner analysis failed")
    rows = {}
    for row in report["report"]:
        path = row.get("relativePath")
        require(isinstance(path, str) and path in files and path not in rows,
                f"Unknown/duplicate scanner path: {path}")
        require(row.get("grade") in tuple(GRADES), f"Invalid grade: {path}")
        require(row.get("scannerErrors") == 0, f"Scanner analysis failed: {path}")
        require(all(number(row.get(key)) for key in METRICS), f"Invalid metrics: {path}")
        issue_counts(row)
        rows[path] = row
    expected = {p for p in files if PurePosixPath(p).suffix in EXTENSIONS}
    require(not expected - rows.keys(), f"Supported files not scanned: {sorted(expected - rows.keys())}")
    return rows


def issue_counts(row):
    require(isinstance(row.get("issues"), list), "Missing scanner issues")
    counts = Counter()
    for issue in row["issues"]:
        require(all(isinstance(issue.get(k), str) for k in ("rule", "category", "message")),
                "Malformed scanner issue")
        require(type(issue.get("count")) is int and issue["count"] > 0, "Invalid issue count")
        counts[(issue["rule"], issue["category"], issue["message"])] += issue["count"]
    return counts


def line_counts(snapshot):
    lines = snapshot.get("lines")
    require(isinstance(lines, dict), "Snapshot has no line counts; capture a new baseline with this gate")
    require(all(type(n) is int and n >= 0 for n in lines.values()), "Invalid line counts")
    require(lines.keys() == {p for p in snapshot["files"] if sized(p)}, "Line counts do not match sized files")
    return lines


def size_growth(path, old_lines, new_lines):
    # Files absent before (new or renamed) start from zero, so they must arrive under the limit.
    before, after = old_lines.get(path, 0), new_lines.get(path, 0)
    if after > LINE_LIMIT and after > before:
        return [f"{after} lines exceeds {LINE_LIMIT} and grew from {before}; split the file instead"]
    return []


def suppressed_lint(snapshot):
    counts = Counter()
    for row in snapshot["lint"]:
        messages = row.get("suppressedMessages", [])
        require(isinstance(messages, list), "Malformed suppressed ESLint diagnostics")
        if not messages:
            continue
        path = Path(row["filePath"]).relative_to(snapshot["root"]).as_posix()
        for message in messages:
            require(message.get("severity") in (1, 2) and isinstance(message.get("message"), str),
                    "Malformed suppressed ESLint diagnostic")
            counts[(path, message.get("ruleId"), message["severity"], message["message"])] += 1
    return counts


def compare(before, after):
    require(before["schema"] == after["schema"] == 1, "Unsupported snapshot schema")
    require(before["identity"] == after["identity"], "Tools, dependencies, policy or configuration changed")
    old = scanner_rows(before["scanner"], before["files"])
    new = scanner_rows(after["scanner"], after["files"])
    old_lines, new_lines = line_counts(before), line_counts(after)
    lint = lint_counts(after["lint"])
    failures = []
    if lint["errors"] or lint["warnings"]:
        failures.append(f"ESLint: {lint['errors']} errors, {lint['warnings']} warnings")
    added_suppressed = suppressed_lint(after) - suppressed_lint(before)
    if added_suppressed:
        failures.append(f"New/increased suppressed ESLint findings: {sum(added_suppressed.values())}")
    file_rows = []
    for path in sorted(before["files"].keys() | after["files"].keys()):
        if before["files"].get(path) == after["files"].get(path):
            # Still check scanner changes on unchanged source: type/context changes can affect it.
            if old.get(path) == new.get(path):
                continue
        kind = "new" if path not in before["files"] else "deleted" if path not in after["files"] else "edited"
        b, a = old.get(path), new.get(path)
        reasons = []
        if a and b:
            if GRADES.index(a["grade"]) > GRADES.index(b["grade"]):
                reasons.append(f"grade {b['grade']} -> {a['grade']}")
            reasons.extend(f"{key} {b[key]} -> {a[key]}" for key in METRICS if a[key] > b[key])
            if issue_counts(a) - issue_counts(b):
                reasons.append("new/increased scanner issues (matched by rule/category/message, ignoring lines)")
        elif a and a["grade"] in "DF":
            reasons.append(f"new poor-quality file ({a['grade']})")
        if path in after["files"]:
            added = Counter(after["suppressions"].get(path, [])) - Counter(before["suppressions"].get(path, []))
            if added:
                reasons.append("new/relocated ESLint/scanner directive; requires separate policy review")
            reasons.extend(size_growth(path, old_lines, new_lines))
        failures.extend(f"{path}: {reason}" for reason in reasons)
        file_rows.append({"file": path, "kind": kind, "before": b, "after": a,
                          "assessed": bool(a), "failures": reasons})
    return {"passed": not failures, "lint": lint, "failures": failures, "files": file_rows,
            "summary": {"new_poor": sum(r["kind"] == "new" and r["after"] is not None and r["after"]["grade"] in "DF" for r in file_rows),
                        "edited_poor": sum(r["kind"] == "edited" and r["after"] is not None and r["after"]["grade"] in "DF" for r in file_rows),
                        "oversized_growth": sum(bool(size_growth(r["file"], old_lines, new_lines)) for r in file_rows),
                        "grade_decreases": sum(r["before"] is not None and r["after"] is not None and GRADES.index(r["after"]["grade"]) > GRADES.index(r["before"]["grade"]) for r in file_rows),
                        "unsupported_changed": [r["file"] for r in file_rows if r["kind"] != "deleted" and not r["assessed"]]}}
