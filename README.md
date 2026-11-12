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

The Markdown contains only fixed field names, structural event indices/counts and
MATCH/DRIFT status, never captured values, IDs or private input paths. It still
reveals workflow structure and **is not anonymized**; do not publish private captures,
or share the summary without reviewing its sensitivity. The command refuses to
overwrite an existing summary and keeps strict exit codes (0 match, 1 drift, 2 invalid).

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

Each `EVENT:BUTTON:click|enter` step fires **after** that zero-based JSONL event
(`EVENT` 0-99), on the current rendered Button index (`BUTTON` 0-31);
`click` uses a real pointer, and `enter` requires real keyboard Tab focus.
The steps must have non-decreasing event indices, with at most eight
actions per capture. Repeating an event index replays multiple Button actions
in their supplied order before the next agent message, without synthesizing
an agent response. For example, use `--action-step 2:0:click --action-step
2:1:enter` to exercise two controls after event 2. Steps cannot be combined
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
