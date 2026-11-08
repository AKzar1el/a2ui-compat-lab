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

`compare` runs offline and never changes the source reports or the pinned baseline. With `--out`, comparison refuses to overwrite **any existing file**, including an input report or earlier comparison; choose a fresh output path for each run. This exclusive-create protection applies to comparison output, not to ordinary `scan` or `releases` output. It distinguishes **resolved**, **newly observed**, and **persistent** discrepancies; flips of a discrepancy's direction; reference-validator and SDK decision changes; changed reference configuration; and added/missing fixture IDs. A strict comparison exits nonzero on observed drift, making an upstream fix a **review gate**, not a silent baseline update. SDK and reference provenance appear in `before` and `after` metadata. Compare scan outputs from the same fixture suite; real Python A2UI parity remains a separate CI check and is not inferred from the comparison.

`doctor` is a fast, read-only, offline installation preflight. It checks the declared Node.js minimum, exact direct dependency pins, package-lock entries and the actual installed package versions. Use `doctor --json --strict --out out/doctor.json` for a machine-readable report (exit 1 on mismatch; exit 2 on invalid invocation). It checks *this workspace's direct packages*, not the npm registry, transitive dependency provenance, React's isolated renderer workspace or remote published-release compatibility. Run `npm ci --ignore-scripts --no-audit --no-fund` to repair a missing or stale installation before retrying.

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

The test runs Vite on loopback with deterministic fixture data, drives real headless Chromium pointer and keyboard input, and closes both the browser and server afterward. Inspect `renderer-react/out/react-browser-trace.json` and `renderer-react/out/react-browser.png`. No LLM, credentials, or external HTTP endpoint is involved after dependency and Chromium installation; GitHub CI installs the browser and uploads both artifacts.

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

## Integration handoff and dependency security

Automated PR integration is defined in docs/INTEGRATION.md. At the exact final verified PR head, include one line in the PR BODY: MERGER_HANDOFF: AKzar1el/a2ui-compat-lab@<full head SHA>. The A2UI-only GitHub Actions merger accepts only source/test/docs changes with fully green exact-head and main CI. Packages, lockfiles, workflows and security policies require owner review; never bypass this restriction. The separate shared fleet merger remains untouched.

A2UI SDK 0.14/0.15 currently depends on Zod 3.25.76 with an unresolved HIGH advisory. See SECURITY.md. npm audit gate discloses it and permits a narrow expiry-bound exception until 2026-12-07; any new vulnerability fails CI.
