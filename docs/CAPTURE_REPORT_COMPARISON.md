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


## Save a redacted Markdown review artifact

The CLI can emit a human-readable, value-redacted review note for use in an
issue or pull-request review without uploading the private input captures:

```sh
node src/capture-compare-cli.mjs --before before.json --after after.json --markdown --strict --out out/capture-review.md
node src/capture-compare-cli.mjs --actions --before before-actions.json --after after-actions.json --markdown --strict --out out/action-review.md
```

Markdown contains the match/drift decision, step counts, changed step indices,
field names and changed action indices (bounded to 100 per category). It omits
captured values, full action contexts and untrusted implementation descriptions.
Use `--json` instead for complete machine-readable indices; `--markdown` and `--json` are mutually exclusive.

`--out` creates a fresh file exclusively, including parent directories,
and refuses to overwrite existing files, symlinks or input reports. It writes a
drifting comparison before returning exit **1** with `--strict`; invalid inputs
or failed writes return **2** without emitting a new report. A matching report
returns **0**. Missing-file and output errors omit absolute paths.

Only publish the redacted review artifact after checking its contents. It still
reveals a capture digest (JSON mode only), comparison shape, step counts and
which fields changed; the raw captures and full replay reports must remain
private. This is an application workflow aid, not evidence of new published-SDK
defects, browser behavior or external adoption.

## Implementation identifier safety

A replay report's `implementation` is producer-controlled text, not trusted
package provenance. Comparison **text and JSON** outputs retain only a bounded,
well-formed published `@a2ui/web_core@x.y.z` label (optionally followed by the
literal `MessageProcessor` role). Any other identifier is displayed as
`unverified implementation`, preventing arbitrary report metadata, terminal
escapes or embedded newlines from leaking into CI output and shared review
summaries. Markdown continues to omit the identifier entirely. Normalization
does **not** authenticate the installed SDK or prove any report was generated
by that version; inspect your pinned environment separately.

## Share a value-free single-capture summary (2026-11-11)

The complete `replay-file.mjs` JSON trace includes **raw data-model values** and
component/surface IDs. For a developer triage note that does not copy those values:

```sh
node src/replay-file.mjs --input capture.jsonl --summary --out out/summary.json
node src/replay-file.mjs --input capture.jsonl --summary --verify-chunks --out out/verified-summary.json
```

`--summary` returns JSON with `schemaVersion`, `kind`, `protocol`, total
`events`, a `chunksVerified` boolean and ordered `steps`. Each step has only
an index, a fixed allowlisted `operation` (or `unclassified` for unknown/ambiguous
messages), `surfacePresent`, `componentCount`, cumulative `actionCount`,
and per-step `actionsEmitted`. This makes message ordering and action changes
inspectable without publishing user-controlled event keys or values.
The summary omits raw action/model values, surface and component IDs, producer
implementation strings, capture bytes and SHA-256. `chunksVerified: false`
means verification was **not run**, not that a mismatch was observed.

This is an **opt-in, local-only structural summary**, not an anonymization
certificate: event counts and patterns may disclose private workflow details.
Inspect before sharing, keep the input capture/private full report local, and
use the separate two-report comparator to detect actual cross-SDK drift.
Without `--summary`, full-report behavior is unchanged. Existing input-size
and chunk-verification limits, path-free diagnostics and exclusive `--out`
creation remain in force.

## Compare privacy-reduced workflow structures (2026-11-11)

Use `src/summary-compare.mjs` to compare the **structure** of two
`replay-file --summary` outputs without retaining private full replay reports:

```sh
node src/summary-compare.mjs --before before-summary.json --after after-summary.json --strict --out structural-diff.json
```

The offline CLI accepts only the exact allowlisted `a2ui-capture-safe-summary`
schema (v0.9), bounded to 10,000 steps and a 4 MiB input file. It validates
consecutive indices, cumulative action-count monotonicity and exact action deltas,
then reports changing protocol operation labels, surface presence, component counts,
cumulative and per-step action counts, inserted/removed steps and whether byte-chunk
verification coverage changed. Up to 100 changed step indices are included; the
remaining count is reported without copying their inputs. Unknown keys, malformed
input, invalid UTF-8 and inconsistent counters are refused with path-free errors.

`--strict` exits 1 for structural drift; invalid inputs or output errors exit 2;
otherwise it exits 0. An optional `--out` writes only to a fresh file and
never overwrites evidence. The output has no raw model values, surface/component
IDs, capture digests or implementation descriptions.

**Interpretation:** this is not same-capture SDK parity testing. Two entirely
different captures can produce identical structural summaries, and a changed
model value with unchanged structure will not count as drift. Treat a MATCH as
equivalent **observed shape only**. Counts, operation sequences and timing order
can still be sensitive workflow metadata; review before sharing.
