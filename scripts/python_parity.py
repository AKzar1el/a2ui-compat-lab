"""Compare actual published Python A2UI Core decisions with TypeScript results.

Requires a2ui-core==0.5.0. This does not mock or reimplement either SDK.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from a2ui.core import Catalog
from a2ui.core.validation import SchemaValidator


def run(ts_report_path: Path) -> dict:
    base = Path(__file__).resolve().parent.parent
    cases = json.loads((base / "fixtures" / "catalog-cases.json").read_text(encoding="utf-8"))
    ts = json.loads(ts_report_path.read_text(encoding="utf-8"))
    ts_by_id = {row["id"]: row for row in ts["rows"]}
    results = []
    for id_, schema, value in cases:
        cat = Catalog.from_json({
            "catalogId": "https://example.com/a2ui-compat-lab-catalog",
            "protocolVersion": "1.0",
            "components": {},
            "functions": [{"name": "check", "parameters": schema, "returnType": "string"}],
        })
        api = cat.functions["check"]
        python_valid = SchemaValidator(api.schema["parameters"]).is_valid(value)
        row = ts_by_id[id_]
        results.append({
            "id": id_,
            "pythonCoreValid": python_valid,
            "webCoreValid": row["webCoreValid"],
            "referenceValid": row["referenceValid"],
            "pythonMatchesReference": python_valid == row["referenceValid"],
            "pythonDiffersFromWebCore": python_valid != row["webCoreValid"],
        })
    diff_ids = sorted(row["id"] for row in results if row["pythonDiffersFromWebCore"])
    ref_mismatches = [row["id"] for row in results if not row["pythonMatchesReference"]]
    baseline = json.loads((base / "baselines" / "expected.json").read_text(encoding="utf-8"))
    expected = sorted(baseline["knownUpstreamDisagreements"] + baseline["additionalDisagreements"])
    ok = len(results) == baseline["cases"] and diff_ids == expected and not ref_mismatches
    return {
        "reportVersion": 1,
        "pythonCoreVersion": baseline["pythonCoreVersion"],
        "cases": len(results),
        "crossSdkDisagreements": diff_ids,
        "pythonReferenceMismatches": ref_mismatches,
        "baselineMatches": ok,
        "rows": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ts", required=True, type=Path, help="JSON report from node src/cli.mjs scan --out FILE")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    report = run(args.ts)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "rows"}, indent=2))
    return 0 if report["baselineMatches"] else 1


if __name__ == "__main__":
    sys.exit(main())
