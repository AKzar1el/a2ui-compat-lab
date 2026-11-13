# A2UI Compatibility Lab

**Local-first, reproducible compatibility testing for the A2UI ecosystem.** This is an experimental developer tool, not an official A2UI conformance certification program.

[![A2UI Compatibility CI](https://github.com/AKzar1el/a2ui-compat-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/a2ui-compat-lab/actions/workflows/ci.yml)

## What it tests

**1. Actual published SDK behavior:** Run 25 controlled JSON Schema Draft 2020-12 fixtures against `@a2ui/web_core@0.15.0` and Ajv. The observed pinned baseline contains **9 TypeScript validation discrepancies**: 3 in [upstream issue #3998](https://github.com/a2ui-project/a2ui/issues/3998) and 6 additional cases. The expectation baseline records *observed defects*, not desirable behavior. A future upstream fix should be reported as a baseline change, not silently discarded.

**2. Cross-language behavior:** An optional Python runner compares the same fixtures against the real `a2ui-core==0.5.0` package. No LLM, paid API, database or browser session is required.

**3. Published release compatibility:** A clean npm project is generated in OS temp for each pinned React + web_core combination. Using `npm install --package-lock-only --strict-peer-deps --ignore-scripts`, the previous 0.14.0 pair resolves; the 0.15.0 pair currently fails `ERESOLVE` because `@a2ui/markdown-it@0.2.2` requires `web_core ^0.14.0`. A rejected install is reported as a compatibility finding, not hidden as a green install.

**4. Real browser replay (isolated compatible pair):** `renderer-react/` strictly installs `@a2ui/react@0.14.0`, `@a2ui/web_core@0.14.0`, and React 19.2.0 independently of the root 0.15 parity experiments. Playwright Chromium mounts a real `A2uiSurface`, clicks a Button with pointer input, verifies the emitted action, applies a simulated agent update and checks changed DOM text, uses keyboard Enter for a second action, then deletes the surface and checks that no stale action fires. It writes a JSON trace and screenshot.

## Start here

Requires **Node.js 22+** and npm; Python 3.10+ is optional.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run scan:check
node src/cli.mjs scan --strict --out out/differential.json
npm run doctor
node src/cli.mjs --version
```

Optional cross-SDK parity:

```bash
python -m pip install a2ui-core==0.5.0
python scripts/python_parity.py --ts out/differential.json --out out/python.json
```

Network-dependent published-release matrix (do not run on every commit or wake):

```bash
npm run probe:releases
node src/cli.mjs releases --strict --json --out out/releases.json
```

`scan` and `npm test` are deterministic and offline after dependency installation. `releases` downloads npm metadata, writes no other repositories, runs no lifecycle scripts and deletes its temporary test directories.

The release report records `observed`, `matchesExpectation`, `npmErrorCode`, `failureKind`, `nextAction` and a bounded diagnostic excerpt for each pinned pair. Possible outcomes are `resolves`, `ERESOLVE`, `infrastructure-error` (registry/network or runner failure) and `install-error` (other npm failure). **Only an actual npm dependency-conflict error can satisfy an expected `ERESOLVE` baseline**; an unreachable registry or timeout always causes drift in `--strict` mode. An upstream fix that makes 0.15 resolve also causes reviewable baseline drift. The offline unit tests exercise these classifications without contacting npm.

### Review SDK upgrades without overwriting evidence

Save a scan report **before** upgrading the pinned dependency, then scan again after the update. The scan records the **installed** `@a2ui/web_core` version rather than the expected baseline version. A version mismatch fails `scan --strict` even if all discrepancy IDs remain unchanged.

```bash
node src/cli.mjs scan --strict --out out/before.json
# After a deliberate package upgrade and npm ci:
node src/cli.mjs scan --out out/after.json
node src/cli.mjs compare --before out/before.json --after out/after.json --strict --json --out out/comparison.json
```

`compare` runs offline and never changes the source reports or the pinned baseline. With `--out`, comparison refuses to overwrite **any existing file**, including an input report or earlier comparison; choose a fresh output path for each run. All CLI JSON report outputs now use exclusive creation; `scan`, `doctor`, `compare` and `releases` refuse to overwrite existing evidence. It distinguishes **resolved**, **newly observed**, and **persistent** discrepancies; flips of a discrepancy's direction; reference-validator and SDK decision changes; changed reference configuration; and added/missing fixture IDs. A strict comparison exits nonzero on observed drift, making an upstream fix a **review gate**, not a silent baseline update. SDK and reference provenance appear in `before` and `after` metadata. Compare scan outputs from the same fixture suite; real Python A2UI parity remains a separate CI check and is not inferred from the comparison.

`doctor` is a fast, read-only, offline installation preflight. It checks the declared Node.js minimum, exact direct dependency pins, package-lock entries and the actual installed package versions. Use `doctor --json --strict --out out/doctor.json` for a machine-readable report (exit 1 on mismatch; exit 2 on invalid invocation). It checks *this workspace's direct packages*, not the npm registry, transitive dependency provenance, React's isolated renderer workspace or remote published-release compatibility. Run `npm ci --ignore-scripts --no-audit --no-fund` to repair a missing or stale installation before retrying.

### Share a structural capture summary without raw values

A raw `replay-file` JSON report contains all observed A2UI model values and IDs.
For issue triage or review, opt into a **value-free, offline** summary:

```sh
node src/replay-file.mjs --input capture.jsonl --summary --verify-chunks --out out/capture-summary.json
```

The summary records ordered step indices, fixed v0.9 message operation names
(`createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`, or
`unclassified`), surface presence, component/action counts, actions emitted
at each step, and whether byte-chunk replay was verified. It excludes model values,
surface/component identifiers, implementation labels and the input digest.
The source capture remains local and the output refuses to overwrite existing
evidence. Counts and event patterns can still be sensitive: inspect before
sharing. This summary is not a complete SDK trace, browser test, cryptographic
attestation or proof of anonymity. See [capture comparison guidance](docs/CAPTURE_REPORT_COMPARISON.md).

### Diagnose growing-string replace overhead locally

`updateDataModel` v0.9 replaces values, so repeatedly sending longer strings can
resend earlier content. For developer-owned private captures, opt into a value-free estimate:

```sh
node src/replay-file.mjs --input private.jsonl --summary --stream-efficiency --out out/stream-efficiency.json
```

`streamEfficiency` reports strictly prefix-growing string runs at a stable surface/path.
`replacementValueBytes` counts UTF-8 bytes of the full values and `incrementalValueBytes`
counts the starting values plus only their growth suffixes. The ratio excludes
JSON envelopes, escapes, framing, compression and actual network transfer.
It is not a real network-savings measurement or SDK append capability.
The option requires `--summary`; it emits no model strings, paths or IDs, although
aggregate counts and event patterns may still be sensitive.

Motivation: [upstream replace-stream issue #3927](https://github.com/a2ui-project/a2ui/issues/3927).
This diagnostic does not implement a protocol extension or prove customer demand.

### Compare two privacy-reduced capture summaries

To check whether the **shape** of two A2UI capture sessions changed without putting
raw model values or IDs into a CI artifact, save each opt-in summary separately:

```sh
node src/replay-file.mjs --input before.jsonl --summary --out before-summary.json
node src/replay-file.mjs --input after.jsonl --summary --out after-summary.json
node src/summary-compare.mjs --before before-summary.json --after after-summary.json --strict --out structural-diff.json
```

For a one-command CI check against a saved baseline, pass the **new private
capture directly**; no intermediate summary or raw replay report is written:

```sh
node src/summary-compare.mjs --before before-summary.json --after-capture new-private.jsonl --strict --out structural-diff.json
```

Add `--verify-chunks` when the baseline was generated with chunk verification.
This internally runs the pinned published SDK in a bounded child process, never
calls a hosted service, and refuses invalid captures with path-free diagnostics.
The original private JSONL stays local. This checks observed v0.9 **structure**,
not value-level parity, user intent, or browser behavior.

The comparison reports changed operation labels, surface presence, component and
action counts, and chunk-verification coverage with a bounded list of affected
step indices. Exit codes: 0 match, 1 drift with `--strict`, 2 invalid inputs
or failed output. It never copies values, IDs, implementation metadata or digests.
**This compares structural workflow shapes, not exact captures or SDK parity:**
different captures with identical shapes can match. For same-input SDK behavioral
drift, use the private full-report comparator documented separately.

### Compare real React/Chromium capture baselines in CI

The private-capture browser replay above produces a **value-free structural JSON report**.
To catch *renderer-visible* drift (Button counts and action chronology) that a
headless SDK summary alone cannot observe, compare two reports offline:

```sh
node src/browser-capture-summary-compare.mjs --before baseline-browser.json --after fresh-browser.json --strict --out browser-diff.json
```

When neither side has a saved browser report yet, compare **two local private
JSONL captures directly** in real React/Chromium. Both captures are rendered
independently; no intermediate browser reports or raw values are written:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --strict --out browser-diff.json
```

By default, direct paired capture mode tests UI structure, visible Button
counts and event order **without activating Buttons**. To compare real pointer
or keyboard interaction behavior across both private captures, first explicitly
review and save a trusted browser report with an action plan
(`--action-step` or a single-Button mode), then opt in:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --action-plan vetted-browser-report.json --strict --out planned-browser-diff.json
```

The saved fixed-schema report must contain at least one verified action. The
same bounded plan is replayed independently in both real Chromium sessions;
invalid, unreachable or stale targets fail closed without exposing capture
values, paths or SDK errors. Default comparisons do **not** compare private action payloads or execute
unreviewed actions. To detect a changed emitted action (including name or
arguments) even when the UI shape and action count match, opt in explicitly
with the same reviewed plan:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --action-plan vetted-browser-report.json --compare-actions --strict --out private-action-diff.json
```

The two Chromium child runs share a fresh, in-memory HMAC key for this one
comparison. Output includes `actionPayloadParity: match|drift`; on drift it also
includes `firstDifferentActionIndex`, the **zero-based position within the
reviewed Button action plan** (e.g. `1` means its second action changed). This
helps localize a regression when rendered structure and action counts agree.
Parity treats JSON object member order as irrelevant (including nested action context),
while preserving action sequence and array order; changing an actual action value
still reports drift. This avoids false regressions from equivalent JSON encodings.
Ephemeral per-action fingerprints are stripped before reports are validated
or published; no raw action payloads, reusable fingerprints or key are written
to the comparison report. Action order and structural metadata can still be
sensitive. This checks emitted action payloads of the approved plan, not
arbitrary user events or the entire private capture. It is
not anonymization: structural and binary parity metadata can still be sensitive.
The flag is refused without two private captures and an explicit saved plan.
Review the plan and the output before enabling interactions or sharing results. Alternatively use `--before vetted-browser-report.json
--after-capture new-private.jsonl` to compare directly against that baseline. Both modes stay
offline after dependencies are installed and preserve strict 0/1/2 exit codes,
no-overwrite protection and generic path-free diagnostics. Structural event
patterns may remain sensitive; review reports before sharing.

### Detect changes in private rendered Text without publishing its value

Two captures can have the same events, Button counts and action payloads yet
show **different Text to the user**. Structural comparison deliberately treats
those as MATCH. To opt into real Chromium rendered-text equality at each agent
event boundary, compare **two private local JSONL captures**:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --compare-rendered-text --strict --out rendered-text-diff.json
```

This uses the published React/core 0.14.0 renderer and captures only the
rendered text of the A2UI surface after each event, before any user actions.
A fresh per-comparison HMAC key protects transient equality fingerprints;
the parent deletes all fingerprints before writing JSON, Markdown or JUnit.
Output contains `renderedTextParity: match|drift` and, on drift,
`firstDifferentRenderedTextEventIndex` (zero-based). Changing private
`updateDataModel` text is detected even when every structural count matches.
It does **not** compare styles, geometry, offscreen content or semantic
intent, and an event index is not proof of the change's cause.

Text-only mode refuses saved reports and approved Button action plans:
no controls are activated. For developers who have **already reviewed and
explicitly authorized** a saved action plan, both signals can instead be
compared in one real Chromium replay:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --action-plan vetted-browser-report.json --compare-actions --compare-rendered-text --strict --out dual-parity-diff.json
```

This combination intentionally performs the vetted Button actions in both
capture sessions. It refuses an absent or invalid plan and cannot activate
unreviewed actions. It samples rendered text after each agent message before
planned interactions, while independently keyed, per-run HMACs compare
emitted action payloads; the keys and transient digests are discarded before
the fixed-schema report is written. The result exposes only both parity
match/drift decisions and first differing indices (when applicable).
Input limits, strict exit codes (0 match / 1 drift /
2 invalid), no-overwrite evidence and path-free refusals still apply.
The values and the ephemeral HMAC key are never saved, but the match/drift
bit and event chronology are still potentially sensitive; this is **not**
anonymization or a guarantee that no secrets can be inferred. Inspect output
before sharing it publicly.

### Detect Button enablement changes that text parity misses

A v0.9 Button's validation checks may disable it while the UI still displays
the same text and Button count. For example, a private form field can become
invalid, leaving a visible but non-activatable Submit Button. Structural and
rendered-text equality do not detect that interaction regression.

Use opt-in, real React/Chromium Button-state parity on two developer-owned
private JSONL captures:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --compare-button-state --strict --out button-state-diff.json
```

For every agent-event boundary, the comparison observes the ordered enabled/
disabled states of up to 32 accessible Buttons (native :disabled or
aria-disabled="true") in the mounted surface. A separate fresh per-run
HMAC key protects transient fingerprints; no labels, IDs, model values, private
paths or reusable digests appear in the fixed-schema JSON/Markdown/JUnit output.
Only `buttonStateParity: match|drift` and, on drift,
`firstDifferentButtonStateEventIndex` (zero-based) are added.
The index is an observation boundary, not proof of cause. The report remains
potentially sensitive and is **not anonymized**.

Without an explicit reviewed action plan, no Button is activated. This option
can be combined with `--compare-rendered-text`; to replay approved
actions and compare their payloads in the same sessions, additionally supply
`--action-plan SAVED-REPORT.json --compare-actions`. Saved-report-only
comparisons and unapproved action plans are refused. The state snapshot occurs
before any planned Button action at that event; it is **not** a comprehensive
accessibility audit, focus/keyboard test, CSS comparison, or input-field validator.
Only the existing compatible published React/core 0.14.0 pair is tested.

### Compare actual Chromium Button Tab-focus traversal

An enabled Button is not necessarily keyboard reachable. To compare the
**observed Tab traversal** at every v0.9 agent-event boundary in two
developer-owned private captures, opt in to a separate real-Chromium check:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --compare-button-focus --strict --out focus-diff.json
```

The browser creates a temporary focus anchor, presses real **Tab** keys (up to
64 per event), and records only the ordered DOM positions of the reachable
accessible Buttons (up to 32), not names, model values, IDs or element markup.
A fresh one-comparison HMAC key protects transient event fingerprints; the
parent discards all fingerprints and exports only
`buttonFocusParity: match|drift` and, on drift,
`firstDifferentButtonFocusEventIndex` (zero-based). A disabled Button that
drops out of Tab navigation can differ even when Text and Button counts match.
Strict exits: 0 match, 1 drift, 2 invalid input or browser failure.

Unlike an approved-action replay, this mode **refuses** any saved action plan:
it never clicks or presses Enter/Space on a Button. It may be combined with
`--compare-button-state`, `--compare-rendered-text` or
`--compare-button-a11y` with no action plan. Focus traversal is reset at each
event by a temporary DOM anchor; any observed action emission is a hard error.
The result measures only ordered positions of reachable rendered Buttons,
not identity when two Buttons exchange positions, all focusable elements,
screen-reader output, WCAG compliance or behavior of other SDK versions.
Even value-free event metadata may be sensitive; this is **not anonymization**.

### Detect real Chromium Button layout shifts without sharing private captures

Two private v0.9 captures can render the same number of Buttons and unchanged
action/event structure yet place a control somewhere else on screen. To compare
actual Chromium Button bounding rectangles at each agent event boundary:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --compare-button-geometry --strict --out button-geometry-diff.json
```

This opt-in mode replays both captures independently in the pinned published
React/core 0.14.0 renderer. It quantizes each visible accessible Button's
viewport `x`, `y`, width and height to whole CSS pixels before using a
new per-comparison HMAC key. Intermediate positions and digests are discarded;
only `buttonGeometryParity: match|drift` and the first differing zero-based
event index are emitted. The mode refuses saved reports and action plans; no
Button is activated. It can be combined with other passive comparison modes.

**Scope:** This is deterministic *within the pinned Chromium test viewport*
for stable fonts and CSS. It is not pixel/screenshot equality, responsive
coverage, styling/color parity, or accessibility certification. Reordering
equal-size controls at identical positions or changes under one rounded CSS
pixel can match. Font, viewport or browser version differences can shift
rectangles; pin the environment for CI. Event indices and parity results
remain sensitive metadata and are not anonymized. No private text, IDs,
coordinates, filenames, or reusable fingerprints are written to the report.

### Compare declared and observed Button accessibility separately

A v0.9 Button may declare `accessibility.label` without the currently pinned
React/core 0.14.0 renderer reflecting that label in Chromium's accessibility tree.
A capture can therefore change its *declared* assistive label while its rendered
Button accessibility snapshot stays the same. The following opt-in comparison
makes the distinction visible without exporting private names:

```sh
node src/browser-capture-summary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --compare-button-a11y --strict --out button-a11y-diff.json
```

At each agent event boundary, the tool independently compares the declared
`accessibility.label` values of v0.9 Button definitions and Playwright's
`ariaSnapshot()` for up to 32 actually rendered accessible Buttons. Each stream
is hashed with an ephemeral, per-comparison HMAC key; private strings, identifiers,
paths, keys and reusable digests are discarded before JSON, Markdown or JUnit
output. The fixed report distinguishes `declaredButtonA11yParity` from
`buttonA11yParity` (each `match|drift`) and provides their separate first
differing zero-based event indices, if any. Strict exits are 0 for match, 1
for drift, 2 for invalid input or failed replay.

In a regression observed with the pinned published renderer, changing only a
v0.9 Button's declared `accessibility.label` changed the declaration comparison
but **did not** change Chromium's observed accessibility snapshot. This is a
specific tested compatibility limitation, not proof about all A2UI renderers or
versions and not an accessibility certification. It does not measure focus
order, spoken screen-reader behavior, color contrast or arbitrary controls.

Two private capture inputs are required; saved-report-only comparisons are
refused. No Button is activated unless an explicit reviewed action plan is
also provided with `--compare-actions`. Event counts and parity bits may still
be sensitive; the result is privacy-reduced, **not anonymized**.

For a readable, value-free GitHub Actions step summary, opt into Markdown output
from the same validated structural comparison (the default remains JSON):

```sh
# In a GitHub Actions shell step, publish only if the structural metadata is safe to share.
# Preserve a strict regression exit code while still showing the summary on drift:
status=0
node src/browser-capture-summary-compare.mjs --before baseline-browser.json --after fresh-browser.json --strict --format markdown --out browser-summary.md || status=$?
if [ "$status" -le 1 ] && [ -f browser-summary.md ]; then
  cat browser-summary.md >> "$GITHUB_STEP_SUMMARY"
fi
exit "$status"
```

On drift, the Markdown shows validated before/after structural counts and fixed
operation names at each changed event (for example, `visibleButtonCount: 1 -> 3`),
so reviewers can distinguish growth from deletion without opening private captures.
It contains no captured values, IDs or private input paths. Workflow metadata is
**not anonymized**; do not publish private captures,
or share the summary without reviewing its sensitivity. The command refuses to
overwrite an existing summary and keeps strict exit codes (0 match, 1 drift, 2 invalid).

For CI platforms that consume **JUnit XML** (for example, a test-report
collector in GitLab or Jenkins), the same offline real-Chromium structural diff
can emit one summary test case and one failing test case per changed event:

```sh
node src/browser-capture-summary-compare.mjs --before baseline-browser.json --after fresh-browser.json --strict --format junit --out browser-regression.xml
```

This is a **JUnit-compatible report artifact**, not a claim that GitHub Actions
renders JUnit natively. Consumers must explicitly ingest or retain the XML.
`--after-capture private.jsonl` also works with this format after the pinned
local Chromium replay. Strict exit codes remain 0 match, 1 structural drift
and 2 invalid inputs or output failure; a drift report is still written before
exit 1, while existing report files are never overwritten. The XML includes
only fixed structural field names, bounded event indices, approved operation
labels and counts, not captured values, identifiers, input paths or screenshots.
**Event patterns remain sensitive and are not anonymized.** Review the report
before publishing or attaching it to a publicly visible build.

For a **single-command real-browser regression check** against a new private
v0.9 JSONL capture, use the saved structural baseline directly:

```sh
node src/browser-capture-summary-compare.mjs --before baseline-browser.json --after-capture private.jsonl --strict --out browser-diff.json
```

This starts the pinned React/core 0.14.0 Chromium renderer locally (install
the isolated `renderer-react/` dependencies and Chromium first). It reconstructs
the baseline's verified Button action positions, pointer/Tab-Enter modes, event
boundaries, and optional sampled loading-placeholder inspection, then checks the
fresh browser report without saving an intermediate report or private capture.
`--after` and `--after-capture` are mutually exclusive. The child is bounded,
shell-free, offline except ephemeral loopback Vite traffic, and reports generic
errors rather than replay diagnostics containing private text. Captures and
baseline reports remain on disk; structural event patterns are **not anonymized**.

Exit codes are 0 for a match, 1 for structural drift with `--strict`,
and 2 for invalid input or an output problem. The comparison is pinned to the
published React/core 0.14.0 replay report schema, and checks lifecycle order,
visible Button/surface counts, action counts, selected interaction plan and
optional sampled loading placeholders. It never outputs captured model values,
identifiers, input paths or action payloads, and refuses to overwrite artifacts.
Use a fresh report path for each run. Structural equality **does not** prove
value-level identity, renderer accessibility, anonymity or external adoption.
The existing `src/browser-trace-compare.mjs` remains the separate,
richer fixed-fixture comparison with screenshot/hash evidence.

## Non-goals and scope

The browser harness is a **narrow React v0.14 integration regression**, not proof of a novel upstream bug. It does not test incompatible React 0.15, other renderers, arbitrary agent output, complete failure recovery, commercial demand, or official A2UI conformance. See [Evidence](docs/EVIDENCE.md) and [Roadmap](docs/ROADMAP.md).

The next differentiating features are real-session replay, event/action trace checking, cross-renderer behavior comparisons and published-version smoke tests. The official A2UI project already has extensive protocol conformance tests; we aim to test *downstream integrated application behavior and released dependencies* rather than duplicate their suite.

## Safety and provenance

- No keys, private customer data or production endpoints are needed.
- Tested packages are independently published: [A2UI](https://github.com/a2ui-project/a2ui).
- All results are version-pinned. A version bump must include fresh evidence and baseline updates.
- Test vectors are original minimal schemas generated for this compatibility study; nothing is copied from confidential systems.
- MIT licensed; not affiliated with Google or the A2UI maintainers.

Maintainer: [AKzar1el](https://github.com/AKzar1el).

## First headless lifecycle replay
The project also exercises the actual published A2UI v0.9 MessageProcessor with a five-event lifecycle (create surface, add components, initialize data, update data, delete surface). JSONL boundary fuzzing at 1/7/57 characters produces identical snapshots; malformed/incomplete lines fail closed. Run `npm run replay:demo` for a JSON trace in `out/replay.json`. This is not a browser or screenshot test.

## Headless component action replay

Run `npm run replay:actions` to produce `out/action-replay.json`. Unlike the state-only lifecycle example, this fixture uses the actual published `MessageProcessor`, `ComponentContext`, and `GenericBinder` to invoke a catalog-defined Button action, capture the emitted agent event, apply an agent data-model response, and repeat the action against the new state. The report includes stable action context, per-step state snapshots, installed core SDK version, fixture digest, and equivalence checks over 1/7/57-character JSONL chunk boundaries. Tests reject taps on missing, deleted, or non-Button components.

**Scope:** this verifies the actual SDK's headless action binding and event dispatch, **not** a real pointer/keyboard interaction, React render, DOM update, screenshot, or upstream-unknown defect. Browser-level interaction and recovery remain open in [issue #2](https://github.com/AKzar1el/a2ui-compat-lab/issues/2).

## Published React renderer browser regression

```bash
cd renderer-react
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm test
npm run build
```

The test runs Vite on loopback with deterministic fixture data, drives real headless Chromium pointer and keyboard input, and closes both the browser and server afterward. Inspect `renderer-react/out/react-browser-trace.json` and `renderer-react/out/react-browser.png`. Browser artifacts are published only after all assertions pass, and a previous output directory is never overwritten. For another local run, use a fresh name from `renderer-react/`: `npm test -- --out-dir run-2` (one alphanumeric, dash or underscore directory name). GitHub CI uses the fresh default `out/` directory. No LLM, credentials, or external HTTP endpoint is involved after dependency and Chromium installation; GitHub CI installs the browser and uploads both artifacts.

## Replay a private capture in actual React/Chromium (experimental)

The fixed browser regression does not accept a developer's own JSONL. An opt-in
local tool now mounts a real published React A2UI surface and replays a private
v0.9 JSONL capture in offline Chromium. From renderer-react/ after installing
the documented pinned dependencies and Chromium:

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --click-single-button --out ../out/browser-summary.json
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --press-single-button-enter --out ../out/keyboard-summary.json
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --click-button-index 1 --out ../out/second-button.json
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --press-button-index-enter 1 --out ../out/second-keyboard.json
```

Each line must contain one **raw v0.9 A2UI message** (not a message wrapper)
and the file must end with a newline. Limits: 512 KiB total, 64 KiB per line,
100 events. The opt-in click checks exactly one rendered Button at the end
and verifies that a genuine browser pointer action emits exactly one agent
event. Alternatively, `--press-single-button-enter` presses **Tab** from the
initial page focus, checks that the single Button receives real keyboard focus,
then presses **Enter** and requires exactly one emitted action. The pointer and
keyboard modes are mutually exclusive. For multi-Button captures use
`--click-button-index N` or `--press-button-index-enter N` to select
a zero-based rendered-Button position in DOM order (N = 0 through 31).
To activate a Button **after an earlier JSONL event but before subsequent
updates or deletion**, add `--action-after-event-index N` (event positions are
zero-based, 0 through 99; requires exactly one Button action mode):

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --click-button-index 0 --action-after-event-index 2 --out ../out/timed-action.json
```

Without this option, actions execute after the final capture event as before.
For an actual **two-step interaction** (Button, agent model response, then a
second Button before deletion), use repeatable scripted action steps:

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --action-step 2:0:click --action-step 3:0:enter --out ../out/two-actions.json
```

Each `EVENT:BUTTON:click|enter|space` step fires **after** that zero-based JSONL event
(`EVENT` 0-99), on the current rendered Button index (`BUTTON` 0-31);
`click` uses a real pointer; `enter` and `space` require real keyboard Tab focus
and dispatch physical Enter or Space to the selected Button.
The steps must have non-decreasing event indices, with at most eight
actions per capture. Repeating an event index replays multiple Button actions
in their supplied order before the next agent message, without synthesizing
an agent response. For example, use `--action-step 2:0:click --action-step
2:1:enter` to exercise two controls after event 2. Use
`--action-step 2:1:space` to test the Space-key activation path in the same
real Chromium renderer; it is not an accessibility certification. Steps cannot be combined
with single-action modes or `--action-after-event-index`. Missing, removed,
or unreachable controls fail the replay; no synthetic agent actions are inserted. The structural report
includes event/button positions, interaction types, and verified action
counts, **not** model values, action contexts, labels or surface IDs.
Positions and event order may still expose workflow structure.

The Button must exist and be reachable at the selected step; invalid or
unreachable steps fail closed. Each scripted step is a real browser activation at
a message boundary, not a recorded user event or complete agent round-trip.
Indexed keyboard mode physically Tabs to the selected Button (at most 64
transitions), failing closed if it is not reachable. Invalid or out-of-range
indices and simultaneous action modes fail closed without fallback.
Failed focus/navigation is a failed replay, not a silent skip; this is
not comprehensive accessibility certification.
Browser HTTP and WebSocket traffic is limited to the ephemeral loopback
Vite origin; no external service or inference endpoint is contacted.

For a private capture that fails only after several agent events, isolate a
**renderer replay prefix** without editing or splitting the JSONL:

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --stop-after-event-index 7 --out ../out/prefix-0-through-7.json
```

`--stop-after-event-index N` replays only events **0 through N (inclusive)**
in real Chromium, where N is zero-based (0–99 and within the input event count).
The entire capture still undergoes bounded JSONL validation before rendering.
The structural report's `events` and `steps` describe only the replayed
prefix; a passing prefix does **not** certify the full capture.
This diagnostic cannot be combined with pointer, keyboard or scripted Button
actions; it never activates captured controls. Use successive prefixes to
isolate the first event that fails, without publishing model values, labels,
surface IDs or private file paths. Like other structural reports, event
chronology may still be sensitive and is not anonymized.

For an immediate **first-observed failing event index** without manually trying
several prefixes, opt into the isolated diagnostic mode:

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --report-first-error --out ../out/first-error.json
```

This replays the fully validated JSONL once in real Chromium without activating
Buttons. On an error **during a replayed event**, the value-free diagnostic
reports `firstObservedFailureEventIndex` (zero-based) and
`processedEventCount` and exits 1 after saving the report. A successful full
replay returns the normal structural report plus a null failure index and exits
0. Input rejection, startup or finalization errors still fail with generic,
path-free diagnostics and exit 2 rather than attributing them to an event.
The observed index is **not proof of root cause**; the failure may have begun
earlier. This mode is mutually exclusive with planned Button interactions,
prefix stopping, and loading-placeholder inspection. Its limited event-count
metadata is not anonymized; review it before publishing.

To regress the **observed failure boundary** between two *private* v0.9
captures without writing intermediate replay reports, compare them directly
in the same pinned published React/core 0.14 + Chromium harness:

```sh
node src/browser-capture-error-boundary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --strict --out out/error-boundary-diff.json
```

This comparison does not activate Buttons or accept an action plan. Each entire
input is validated, replayed independently with `--report-first-error`, and
reduced to fixed-schema before/after event counts and first observed failure
indices (`null` for healthy full replay). With `--strict`, unchanged boundaries
and counts exit 0, drift exits 1, malformed input/unsupported modes or browser
startup/finalization errors exit 2. A **MATCH can mean both captures fail at
the same event**, not that either is healthy or that failures share a cause.
For CI where **both replays must also have no observed Chromium errors**,
add `--require-no-observed-failures` together with `--strict`:

```sh
node src/browser-capture-error-boundary-compare.mjs --before-capture old-private.jsonl --after-capture new-private.jsonl --require-no-observed-failures --strict
```

This opt-in policy preserves the separate `errorBoundaryParity` result, but
sets `ok: false` and strict exit 1 if **either** replay reports an observed
failure, including when both fail at the same event. Its additional
`observedFailuresAbsent` field means only that no failures were observed by
this bounded replay, **not** that an app is generally healthy. Without the
flag, existing parity behavior and report shape are unchanged. Duplicate
policy flags fail closed with exit 2.

No source paths, model values, browser diagnostics or reusable digests are
exported. Event counts and boundary positions may still be sensitive and are
not anonymized; review output before sharing. Existing output is never overwritten.

To inspect a streaming-UX regression that only appears **between** v0.9
messages, opt into intermediate Chromium loading-placeholder diagnostics:

```sh
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --inspect-loading-placeholders --out ../out/loading-visibility.json
node scripts/browser-capture-replay.mjs --input ./private-capture.jsonl --reject-loading-placeholders
```

`--inspect-loading-placeholders` adds per-event `loadingPlaceholderCount`
and aggregate `loadingPlaceholderEvents` to the structural report. The
counts are sampled after each **complete event** and two animation frames;
they can reveal the published React renderer's temporary `[Loading root...]`
placeholder before root components arrive. `--reject-loading-placeholders`
uses the same check but fails closed rather than accepting a capture that
displays a matching placeholder. This exercises the downstream consumer gap
described in [upstream issue #2013](https://github.com/a2ui-project/a2ui/issues/2013);
it is not a novel upstream defect. By default these optional fields are absent.

The detector intentionally counts matching *visible leaf divs*, not their text,
component IDs or model values. It is a bounded pattern heuristic: app content
that itself looks like `[Loading ...]` can trigger a false positive, and
placeholders that appear and disappear *between* the sampled frames can be
missed. This is not a continuously recorded visual trace, comprehensive
streaming validation, cross-renderer parity, anonymity or a production UI fix.
Do not share capture structure without reviewing it.

Reports show only fixed lifecycle operation labels, per-step mounted-surface,
visible-Button and emitted-action counts, and pinned React/core 0.14.0
provenance. They exclude captured values, action contexts, surface/component
identifiers, input paths and screenshots. The --out option never overwrites
existing files. **Workflow structure can still be sensitive**, so this is
not anonymization or proof of complete renderer correctness. React/core 0.15
remains blocked separately by published npm peer constraints. The CI acceptance
uses the synthetic fixture; external developer adoption remains unverified.

Captures must contain a `createSurface` event. An unsupported catalog or
failed surface creation is rejected, **not** reported as a passing empty
render. Both CLI and programmatic replay failures use fixed messages rather
than quoting private capture identifiers or SDK diagnostics. The basic
catalog is the tested target; arbitrary custom catalogs are not supported
by this harness.

## Fault/recovery replay (headless)

Run `npm run replay:recovery` to create `out/recovery.json` using the published `@a2ui/web_core@0.15.0` v0.9 MessageProcessor, without any network access after installation. The fixture exercises updates before surface creation, an invalid catalog, and a stale update after deletion while checking that a second live surface still works and a deleted surface can be recreated with fresh data.

The report records each applied or rejected SDK event, its error and exposed surface state. It checks that rejected events do not alter any *observed* surface or emit actions, and stops if a rejected event visibly mutates state. All four JSONL chunk sizes must produce the identical trace; the pinned three rejection positions are verified in CI and saved as an artifact. This demonstrates error containment in **headless published SDK APIs**, not React rendering, hidden SDK internals or a novel upstream defect. Browser recovery remains separate P1 work.

The project also exercises the actual published A2UI v0.9 MessageProcessor with a five-event lifecycle (create surface, add components, initialize data, update data, delete surface). JSONL boundary fuzzing at 1/7/57 characters produces identical snapshots. The separate `parseJsonLinesBytes` transport parser accepts `Uint8Array` / `Buffer` chunks, handles split multibyte UTF-8, and fails closed on invalid encoding, incomplete lines and resource limits. `npm run replay:demo` writes `out/replay.json` with both original string-chunk and localized byte-chunk SDK replay traces; CI uploads it alongside parity results. These are **headless SDK tests**, not browser or screenshot tests.

The string-based JSONL replay harness enforces a 256 KiB limit on **each untrimmed line** and a 10,000-message limit by default. The configurable `parseJsonLines(chunks, {maxLineBytes, maxMessages})` counts UTF-8 bytes correctly across split surrogate pairs. These are local test-harness safety boundaries, not assertions about upstream SDK transport handling.

## Replay your own A2UI v0.9 capture

Save a local UTF-8 JSONL transcript with **one A2UI message per line and a final newline**. The `createSurface` event can use the published catalog ID or `__BASIC_CATALOG__` placeholder as shown in the included sample.

```bash
node src/replay-file.mjs --input fixtures/lifecycle-v09.jsonl
node src/replay-file.mjs --input fixtures/lifecycle-v09.jsonl --out out/my-replay.json
node src/replay-file.mjs --input fixtures/lifecycle-v09.jsonl --verify-chunks
```

Use `--verify-chunks` to replay the same local capture through the real SDK at 1, 7, 57 and full-buffer **UTF-8 byte** chunk boundaries (including splits inside Unicode code points). It compares every observable lifecycle snapshot with the ordinary replay, exports `chunkTrials` and `allChunksMatch`, and exits nonzero instead of writing a report if the replay differs. To keep one-byte replay bounded, verification is opt-in and limited to captures of 512 KiB; ordinary capture replay still accepts up to 4 MiB. The test harness parses complete JSONL frames from chunks; it does not prove the published SDK itself accepts streaming network byte chunks.

The offline report includes a content SHA-256, event count and per-event component/data-model state from the **real pinned `@a2ui/web_core@0.15.0` MessageProcessor**. It does not perform browser rendering, trigger an agent or certify protocol conformance. Unsupported or malformed streams fail with a nonzero exit code; no report is written on replay failure. Existing output files are never overwritten, to avoid presenting stale evidence as a fresh run.

Capture size is capped at 4 MiB, raw lines at 256 KiB and frames (including blank lines) at 10,000; malformed UTF-8 and non-newline-terminated input are rejected. **Reports reproduce captured data-model values, potentially including private information.** Keep real customer traces local and review or redact them before sharing CI artifacts.

## Compare two private captures without intermediate reports

For a local structural regression check between two private A2UI v0.9 JSONL captures, run:

```bash
node src/summary-compare.mjs --before-capture old.jsonl --after-capture new.jsonl --strict --out out/structural-diff.json
```

Both inputs are replayed separately by the pinned published headless SDK in bounded child processes. Only fixed lifecycle-operation names and per-event state/action **counts** are compared. No intermediate replay or summary report is saved, and existing output files are never overwritten. Add `--verify-chunks` to verify both captures at bounded UTF-8 byte boundaries. A matching observed structure returns 0, drift returns 1 with `--strict`, and malformed inputs return 2. Model-value changes alone can MATCH: this is **not** value parity, evidence of browser behavior, or guaranteed anonymization. Keep private captures local and review structural metadata before publishing.

## Compare real Chromium replay evidence offline

After two successful real-browser runs using the **same fixture**, compare their JSON traces before and after a deliberate published SDK or application update:

```bash
node src/browser-trace-compare.mjs --before before/react-browser-trace.json --after after/react-browser-trace.json
node src/browser-trace-compare.mjs --before before/react-browser-trace.json --after after/react-browser-trace.json --strict --json --out out/browser-comparison.json
node src/browser-trace-compare.mjs --before before/react-browser-trace.json --after after/react-browser-trace.json --before-png before/react-browser.png --after-png after/react-browser.png --strict --json
node src/browser-trace-compare.mjs --before before/react-browser-trace.json --after after/react-browser-trace.json --markdown --strict --out out/browser-review.md
```

The comparator checks ordered **browser checkpoints, emitted agent actions, runtime errors, console errors, accessible-name findings, optional PNG screenshot SHA-256 and the replay pass flag**. New real-Chromium traces bind the screenshot PNG bytes to the trace digest, making screenshot-only byte changes report DRIFT even when logged Text and actions match. A mixed legacy/new pair without both digests is not a match; two old traces remain comparable with `visualEvidence: legacy-unavailable`. PNG-byte differences are not perceptual/pixel-level diffs, and the screenshot is captured at a mounted-surface checkpoint, not at every subsequent action. It records pinned versions separately: a version change alone is *not* a behavior regression. Input must be a schema-v1 Chromium trace with the same fixture SHA-256 **and the same rendering harness**. Missing or different harness provenance, malformed package versions, action/error/accessibility records, mismatched fixtures, and invalid JSON are rejected (exit 2), not silently reported as a match. Source trace files are never modified; --out refuses to overwrite an existing report. The JSON summary lists changed array indices and counts without embedding potentially private action contexts (the first 100 indices per category are shown). Each input is capped at 8 MiB. `--strict` exits 1 on drift or unhealthy candidate and 2 on invalid or incomparable evidence.

For pull-request reviews, opt into `--markdown` to produce a short human-readable report containing the MATCH/DRIFT outcome, candidate health, pinned SDK versions, before/after counts and changed indices per evidence category, and PNG verification status. It deliberately excludes raw action contexts, DOM text, console error contents and local paths. `--markdown` and `--json` are mutually exclusive; `--out` emits Markdown when selected (and still refuses overwrites). `--strict` retains exit 0 for match, 1 for drift and 2 for invalid evidence. A readable report is not a substitute for the original JSON trace or actual browser evidence.

The optional **paired `--before-png` and `--after-png` flags** verify the stored screenshot files against their traces' recorded SHA-256. Both digests must be present, both files must be regular files (not symlinks), and each PNG signature and byte length must be valid for the bounded 32 MiB read. A modified or missing screenshot fails closed with exit 2 without echoing its path or contents; JSON-only comparisons still work and report `pngArtifactsVerified: false`. The flag checks integrity of saved bytes against a trace, **not** that the PNG is perceptually equivalent, safely decoded, independently attested, or unmodified together with its JSON report.

This is a reproducible **local trace-diff tool**, not browser execution, an attestation that a trace is authentic, or official A2UI conformance. Generate both traces through the real Chromium harness separately, and keep any customer captures and artifacts private unless reviewed and redacted.

## Integration handoff and dependency security

Automated PR integration is defined in docs/INTEGRATION.md. At the exact final verified PR head, include one line in the PR BODY: MERGER_HANDOFF: AKzar1el/a2ui-compat-lab@<full head SHA>. The A2UI-only GitHub Actions merger accepts only source/test/docs changes with fully green exact-head and main CI. Packages, lockfiles, workflows and security policies require owner review; never bypass this restriction. The separate shared fleet merger remains untouched.

A2UI SDK 0.14/0.15 currently depends on Zod 3.25.76 with an unresolved HIGH advisory. See SECURITY.md. npm audit gate discloses it and permits a narrow expiry-bound exception until 2026-12-07; any new vulnerability fails CI.
