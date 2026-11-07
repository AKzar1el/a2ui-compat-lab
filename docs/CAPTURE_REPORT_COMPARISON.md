# Compare two observations of the same A2UI JSONL capture

This is an offline, value-redacting *state comparison* for the existing published-SDK v0.9 capture replay reports. It is not a second JSON Schema conformance checker and does not claim to test a browser, multiple SDKs automatically, or a novel upstream defect.

Generate reports from the **same capture bytes** using each candidate pinned SDK / harness installation:

```sh
node src/replay-file.mjs --input capture.jsonl --out before.json
# Repeat in the separately pinned candidate environment for after.json.
node src/capture-compare-cli.mjs --before before.json --after after.json --strict --json
```

The comparison requires matching SHA-256, byte length, protocol and event count. It rejects mismatched captures rather than mislabeling input differences as SDK regressions. For each event it checks the observable surface ID, existence, component ID list/order, data model and emitted-action count. It reports **only step indices and changed field names**, never data values or action payloads. Differences exit with status 1 when `--strict` is set; malformed or unrelated reports exit 2; matches exit 0.

The raw input capture and per-SDK replay reports **can contain confidential data**. Keep them local, private, and out of public CI artifacts. The comparison output is intentionally much narrower, but still includes the input SHA-256, implementation names and event count. It does not prove two SDKs accept the same set of *different* inputs or that their browser DOM output matches.

The regression tests run the committed five-event fixture through the actual installed published A2UI SDK and then use **synthetic mutations** to prove field-level drift detection, input integrity checks and privacy of the comparison output. They do not represent a newly observed published-SDK disagreement.
