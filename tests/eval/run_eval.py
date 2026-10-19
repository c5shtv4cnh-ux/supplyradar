"""Week 1 checkpoint: measure Gemini field accuracy on the synthetic invoices.

    export GEMINI_API_KEY=...            # from Google AI Studio
    python3 tests/eval/run_eval.py                       # samples/eval/*.png
    python3 tests/eval/run_eval.py --dir samples/demo --model gemini-2.5-flash-lite

A field counts as correct when it matches the printed value:
numbers within 0.01, dates and BIN exactly, names after normalisation.
Exit code 1 if accuracy is below --target (default 80 %, the plan's checkpoint).
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "backend"))

from supplyradar import checks, gemini, products  # noqa: E402

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf"}
HEADER_FIELDS = ["supplier_bin", "invoice_number", "invoice_date", "total"]
LINE_FIELDS = ["name", "quantity", "price", "total"]


def same(field, expected, actual):
    if expected is None:
        return actual is None
    if actual is None:
        return False
    if field in ("total", "quantity", "price"):
        try:
            return abs(float(expected) - float(actual)) < 0.01
        except (TypeError, ValueError):
            return False
    if field == "name":
        return products.normalize(expected) == products.normalize(actual)
    if field == "supplier_bin":
        return "".join(c for c in str(actual) if c.isdigit()) == expected
    return str(expected).strip() == str(actual).strip()


def score(truth, got):
    results = {}
    for f in HEADER_FIELDS:
        results[f] = same(f, truth[f], got.get(f))
    got_lines = got.get("lines") or []
    for i, line in enumerate(truth["lines"]):
        other = got_lines[i] if i < len(got_lines) else {}
        for f in LINE_FIELDS:
            results[f"lines.{i}.{f}"] = same(f, line[f], other.get(f))
        results[f"lines.{i}.product_key"] = (
            products.product_key(line["canonical_name"]) == products.product_key(other.get("canonical_name") or "")
        )
    results["line_count"] = len(got_lines) == len(truth["lines"])
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "samples" / "eval"))
    ap.add_argument("--model", default=None, help="defaults to GEMINI_MODEL or gemini-2.5-flash-lite")
    ap.add_argument("--target", type=float, default=80.0)
    ap.add_argument("--pause", type=float, default=4.0, help="seconds between calls (free-tier rate limit)")
    ap.add_argument("--out", default=None, help="write a JSON report here")
    args = ap.parse_args()

    files = sorted(p for p in Path(args.dir).iterdir() if p.suffix.lower() in MIME)
    if not files:
        sys.exit(f"no invoices in {args.dir}")

    total_ok = total = 0
    flagged_correctly = 0
    report = []
    print(f"{'file':32} {'fields':>8} {'ok':>5} {'time':>6}  checks")
    for path in files:
        truth = json.loads(path.with_suffix(".json").read_text())
        started = time.time()
        try:
            got = gemini.extract_invoice(path.read_bytes(), MIME[path.suffix.lower()], model=args.model)
            error = None
        except gemini.GeminiError as err:
            got, error = {}, str(err)
        elapsed = time.time() - started
        res = score(truth, got)
        ok = sum(res.values())
        total_ok += ok
        total += len(res)
        issues = checks.run_checks(checks.clean_invoice(got)) if got else [{"code": "error"}]
        expected_issues = checks.run_checks(checks.clean_invoice(truth))
        same_verdict = bool(issues) == bool(expected_issues)
        flagged_correctly += same_verdict
        wrong = [k for k, v in res.items() if not v]
        print(f"{path.name:32} {len(res):8} {ok:5} {elapsed:5.1f}s  "
              f"{'review' if issues else 'checked'}{'' if same_verdict else ' (unexpected)'}"
              f"{'  ERROR ' + error if error else ''}")
        if wrong:
            print(f"{'':32} wrong: {', '.join(wrong[:8])}{' ...' if len(wrong) > 8 else ''}")
        report.append({"file": path.name, "fields": len(res), "correct": ok, "wrong": wrong,
                       "seconds": round(elapsed, 2), "error": error, "extracted": got})
        time.sleep(args.pause)

    accuracy = 100 * total_ok / total
    print(f"\nField accuracy: {total_ok}/{total} = {accuracy:.1f} %  (target {args.target:g} %)")
    print(f"Check verdict matches ground truth: {flagged_correctly}/{len(files)} invoices")
    if args.out:
        Path(args.out).write_text(json.dumps({"accuracy": accuracy, "invoices": report}, ensure_ascii=False, indent=2))
    sys.exit(0 if accuracy >= args.target else 1)


if __name__ == "__main__":
    main()
