# Compare two observations of the same A2UI JSONL capture

This is an offline, value-redacting *state comparison* for the existing published-SDK v0.9 capture replay reports. It is not a second JSON Schema conformance checker and does not claim to test a browser, multiple SDKs automatically, or a novel upstream defect.

Generate reports from the **same capture bytes** using each candidate pinned SDK / harness installation:

```sh
node src/replay-file.mjs --input capture.jsonl --out before.json
# Repeat in the separately pinned candidate environment for after.json.
node src/capture-compare-cli.mjs --before before.json --after after.json --strict --json
```

The comparison requires matching SHA-256, byte length, protocol and event count. It rejects mismatched captures rather than mislabeling input differences as SDK regressions. For each event it checks the observable surface ID, existence, component ID list/order, data model and emitted-action count. It reports **only step indices and changed field names**, never data values or action payloads. Differences exit with status 1 when `--strict` is set; malformed or unrelated reports exit 2; matches exit 0.

Malformed JSON is refused with a generic error rather than the JavaScript parser's original message, which can contain fragments of input. This also applies to `--actions` mode.

The raw input capture and per-SDK replay reports **can contain confidential data**. Keep them local, private, and out of public CI artifacts. The comparison output is intentionally much narrower, but still includes the input SHA-256, implementation names and event count. It does not prove two SDKs accept the same set of *different* inputs or that their browser DOM output matches.

The regression tests run the committed five-event fixture through the actual installed published A2UI SDK and then use **synthetic mutations** to prove field-level drift detection, input integrity checks and privacy of the comparison output. They do not represent a newly observed published-SDK disagreement.

## Compare actual headless Button event traces

Message-only JSONL replay does **not** click any UI controls, so its action
counts normally remain zero. For actual published-SDK Button action fidelity,
compare the existing `replay-action-report.mjs` output from two pinned SDK
installations:

```sh
node src/replay-action-report.mjs > before-actions.json
# Repeat using the separately pinned candidate SDK installation.
node src/replay-action-report.mjs > after-actions.json
node src/capture-compare-cli.mjs --actions --before before-actions.json --after after-actions.json --strict --json
```

The `--actions` mode verifies identical fixture SHA-256 and replay step count,
valid complete deterministic traces, every observable snapshot, and **complete
outbound actions** including routing and context (not just action counts).
It reports only changed step fields and action indices; the output never
includes captured action payloads or data values. Input action reports are
**not redacted** and must remain private. The action fixture runner uses the
actual published MessageProcessor/GenericBinder; it is headless and does not
establish browser-DOM parity or a new upstream defect. The test mutates
reports synthetically after an actual pinned-SDK replay.
