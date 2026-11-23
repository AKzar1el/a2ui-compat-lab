# Experimental v1.0 Text binding migration preflight

The Lab is primarily a **v0.9 / published-React-0.14** replay product.
This separate offline diagnostic inspects saved **v1.0 surface-message JSONL**
for one potential migration mistake: writing the old v0.9 plain path or call
shape in a Text.text property when a binding or function result was intended.

## Run locally on a developer-owned capture

Run: node src/v1-text-binding-preflight.mjs --input PRIVATE-v1-messages.jsonl

Add --strict only if your migration CI should exit 1 for possible legacy Text
directives. Ordinary mode exits 0 and returns a **review advisory**, not
a conformance verdict. Invalid or unsupported input exits 2.

To also inspect five published interactive input `value` slots, opt in with:
`node src/v1-text-binding-preflight.mjs --input PRIVATE-v1-messages.jsonl --include-input-values`.
This opt-in retains all existing Text-only behavior without the flag and produces
an explicit schemaVersion **2** report with separate `textCandidateCount` and
`inputValueCandidateCount`, fixed counts by input component type, and a unified
bounded `candidateLocations` list. `--strict` exits 1 for either kind of review
candidate when opt-in is active. The default report remains schemaVersion 1.

Input must be newline-terminated JSONL, 1 byte to 1 MiB, at most 1,000
surface messages, each at most 128 KiB, with protocol version exactly 1.0.
Only createSurface, updateComponents, updateDataModel, and deleteSurface
message envelopes are accepted. The scan considers Text entries in both
createSurface.components (when provided inline at surface creation) and
updateComponents.components, using the same legacy-like text shapes. It does
not scan arbitrary other component fields or other renderers.

Output is fixed-schema JSON with counts and at most **32** `candidateLocations`
entries. Each contains only a **1-based JSONL line number**, **0-based
component array index**, and fixed `path`/`call` kind. Open the private
capture locally at that line to review the affected Text value. The
`candidateLocationsOmitted` count reports any additional candidates beyond
32; the total counts always include them. No original component IDs, values,
paths, full capture digest, filesystem path, or snippets are emitted. These
structural positions can reveal capture layout, so keep reports within your
trusted development workflow. It does not upload data or make network requests.

Legacy v0.9 relative data bindings also qualify: `{"path":"firstName"}` inside
a repeated list row is a valid relative binding, even without a leading slash.
The advisory now detects that Text.text shape alongside absolute paths. A
container's `children.path` remains a valid v1 ChildList property and is
intentionally not flagged by either mode.

## Optional interactive input migration scan

With `--include-input-values`, the diagnostic also checks the `value` slot
of exactly **TextField, CheckBox, Slider, ChoicePicker, DateTimeInput** in
`createSurface.components` and `updateComponents.components`. Only a single,
nonempty legacy `{"path":"..."}` object is considered; proper v1
`{"@path":"..."}`, ordinary literals, extended literal objects and unrelated
fields are not flagged. Relative paths such as `{"path":"firstName"}` qualify.

Input findings have a fixed `inputValuePath` location kind; the 1-based
line and 0-based component index point to the private capture for review.
The report exposes counts but **never** original component IDs, values,
binding paths, data, filesystem paths or snippets. All slots share the same
32-location cap; `candidateLocationsOmitted` counts the rest. Metadata
may still be sensitive and must remain within trusted developer workflows.

The released `@a2ui/web_core@0.15.0` strict processor reproduces a
published-v1 data-resolution distinction for all five: `@path` reads the
model value, while plain `path` remains a literal object. This tests
headless resolution, **not** browser input events or two-way writeback.
The A2UI v1 binding docs describe `@path` for inputs:
https://a2ui.org/concepts/data-binding/ . A literal object can be intentional:
these are migration **advisories**, not schema or security errors.
See issue #184 for the evidence and acceptance scope.


## Why this matters

The **installed published** @a2ui/web_core@0.15.0 was independently probed
on November 23, 2026 through the real v1_0.MessageProcessor in strict
validation mode and DataContext resolution:

| v1.0 Text.text | Strict processing | Resolved value |
| --- | --- | --- |
| {"@path":"/name"} | accepted | "Ada" |
| {"path":"/name"} | accepted | literal object with path key |
| {"@call":"formatString", "args":{...}} | accepted | "Hi Ada" |
| {"call":"formatString", "args":{...}} | accepted | literal call-shaped object |

A separate actual v0_9 probe confirmed plain path resolves to "Ada"
at v0.9, while @path is rejected there. These are released-version headless
observations, not a browser-rendered action or a new upstream bug.

Upstream [#4346](https://github.com/a2ui-project/a2ui/issues/4346)
reported related behavior against 0.16.0 on November 21, 2026.
Upstream [#4348](https://github.com/a2ui-project/a2ui/issues/4348)
reported a distinct v1 Catalog.fromJson check-rule validation mismatch.
This Lab preflight adds consumer-capture migration triage, not another
official conformance validator or a claim to fix either upstream issue.

## Important limitation: literal objects are valid

At v1.0, an object containing a path or call key can intentionally represent
**literal data**. The tool cannot infer developer intent and never calls
such an object invalid. It emits review_ambiguous_legacy_shapes only when
an exact old directive-shaped value occurs in Text.text. A developer should
check the intended UI: if a binding was intended, use @path or @call; if a
literal object was intended, keep it and disregard the advisory. False
positives are possible.

No v1.0 React/Chromium renderer, Python parity, actual external capture,
customer adoption, or revenue is established by this experiment.
The pinned root SDK remains 0.15.0; no dependency upgrade or exception
override is required for the test.
