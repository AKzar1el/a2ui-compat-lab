# Evidence register (2026-11-07)

This register is intentionally explicit about reproductions, assumptions and what remains unproven.

## A. Real SDK differential validation

- Node: v22.22.2 (Windows x64), `@a2ui/web_core@0.15.0`, `ajv@8.17.1`.
- Python: `a2ui-core==0.5.0`, Python 3.13 with `jsonschema` supporting Draft 2020-12.
- 25 fixture inputs; A2UI TS vs JSON Schema: **9 unconditional disagreements**.
- Official Python A2UI Core vs TypeScript A2UI Core: **9 identical disagreements**.
- Cases previously documented upstream: `maxProperties`, `minProperties`, a root-level `not` example.
- Additional covered keywords: `dependentRequired`, `propertyNames`, valid `patternProperties` case, `dependentSchemas`, `if/then`, `contains`.
- A2UI TS accepts inputs the reference rejects for 8 of 9 cases; one valid input is rejected.
- Two format cases (`email`, `uuid`) are **not counted** because JSON Schema format assertions are opt-in.
- Source: https://github.com/a2ui-project/a2ui/issues/3998 (upstream acknowledges its shared suite does not cover the originally reported cases).
- Automated reproduction: `npm test`, `npm run scan:check`, `scripts/python_parity.py`.
- This study tests catalog-defined function schemas, not the full network RPC or renderer surface lifecycle.

## B. Published package graph regression

A clean throwaway npm manifest with the following direct dependencies was tested with strict peer resolution:

| Version pair | Result | Observation |
| --- | --- | --- |
| `@a2ui/react@0.14.0` + `@a2ui/web_core@0.14.0` | exit 0 | strict graph resolves |
| `@a2ui/react@0.15.0` + `@a2ui/web_core@0.15.0` | exit 1 | `npm ERESOLVE` |

The 0.15.0 React package depends on `@a2ui/markdown-it@^0.2.2`, whose 0.2.2 peer constraint is `@a2ui/web_core@^0.14.0`. The known stable prior pair is an experimental control, not proof that every old combination is supported.

Similar historical packaging failures: https://github.com/a2ui-project/a2ui/issues/1930 and https://github.com/a2ui-project/a2ui/issues/1766

Automated reproduction: `npm run probe:releases`. That command accesses the npm registry and may become stale as packages change; review any unexpected improvement or regression before editing the baseline.

On 2026-11-07, the two-case strict resolution probe was repeated on Windows x64 with Node v22.22.2 and npm 10.9.7 (45-second timeout per case): the pinned 0.14 pair exited 0 (`resolves`); the 0.15 pair exited 1 with authoritative `npm error code ERESOLVE` and the `@a2ui/markdown-it@0.2.2` / web_core `^0.14.0` peer constraint. The probe classifier now separates confirmed `ERESOLVE` from registry/network errors, runner timeouts, interrupted processes and other npm failures. Four additional offline unit tests cover those branches. A future registry failure must not be counted as confirmation of a known broken release.

## C. Competition and current bounds

- Official A2UI maintains an extensive conformance suite, Theater, Composer and SDK-specific tests: https://github.com/a2ui-project/a2ui
- The project's own issue tracker documents missing/partial tests and render-error recovery gaps: https://github.com/a2ui-project/a2ui/issues/3842 and https://github.com/a2ui-project/a2ui/issues/3993
- A baseline fix upstream may eliminate a specific fixture finding; our durable purpose must be *continuous released-version regression and integrated UI replay*.
- **No paying users, commercial demand, pixel-diff regression baseline, or complete multi-renderer browser replay has been validated.** A narrow React browser screenshot now exists; do not overstate its coverage.
- A2UI specification version labels are changing; pin exact package versions and surface protocol version in every report.

## D. Honest acceptance gates for pilot

1. CI runs clean with a real SDK, stable baseline and reference validator.
2. Optional real Python comparison runs and aligns on all 25 inputs.
3. Release matrix reproduces 0.14 vs 0.15 strict install difference.
4. A deterministic React v0.14 browser surface/action replay now exists; an independent novel renderer failure absent from upstream tests is still unproven.
5. Next: find at least one external developer or integration team for usability feedback.

## First headless lifecycle replay
The project also exercises the actual published A2UI v0.9 MessageProcessor with a five-event lifecycle (create surface, add components, initialize data, update data, delete surface). JSONL boundary fuzzing at 1/7/57 characters produces identical snapshots; malformed/incomplete lines fail closed. Run `npm run replay:demo` for a JSON trace in `out/replay.json`. This is not a browser or screenshot test.

## E. Offline review of observed SDK upgrades (2026-11-07)

The scan now resolves the installed `@a2ui/web_core` package's own version (its `package.json` is not a public export); the strict pinned baseline fails if the installed version differs, even if the set of divergent fixture IDs has not changed. `src/compare.mjs` compares two saved report-v1 scan artifacts and fails closed on malformed reports, fixture-set drift, changed JSON Schema reference decisions, different validator configuration, new/resolved discrepancies and changed SDK decisions (including otherwise non-divergent controls). Inputs and original baseline are never mutated.

The comparison regression tests include **synthetic** before/after version and decision changes, including a discrepancy reversing direction. These demonstrate classification and drift detection only, **not** a new defect or a measured difference in any unreleased SDK. The baseline remains on actual `@a2ui/web_core@0.15.0`; the existing real 25-case scan still finds nine discrepancies. Real Python `a2ui-core==0.5.0` parity remains covered by the separate CI step. Browser rendering and customer validation remain open milestones.

## E. Published core SDK Button action and state replay (2026-11-07)

- Added an offline scripted sequence that creates an A2UI v0.9 surface, resolves a Basic Catalog Button through the actual `ComponentContext` and `GenericBinder`, dispatches its event, updates the data model as a simulated agent response, and dispatches again.
- The first emitted `confirm-choice` event resolves `selection: alpha`, and the second resolves `selection: beta`, both with the real `sourceComponentId` and `surfaceId`. The harness removes only nondeterministic SDK-generated timestamps from its **comparison trace**.
- The JSON report records the installed `@a2ui/web_core` version, fixture SHA-256, seven snapshots, two emitted events, and equivalent outputs for 1/7/57-character JSONL chunks. Regression tests require failure for missing, deleted, and non-Button targets as well as malformed step envelopes.
- Run `npm run replay:actions` and inspect `out/action-replay.json`; `npm test` runs the same assertions without network access.
- **Limitations:** no React package, browser DOM rendering, pointer or keyboard event, screenshot, and no evidence of a new upstream bug. This is a step toward the independent real-renderer acceptance gate in issue #2, not its completion.

## E. Published React + core 0.14.0 browser regression (2026-11-07)

- **Dependency isolation:** A standalone `renderer-react/package-lock.json` strictly installs `@a2ui/react@0.14.0`, `@a2ui/web_core@0.14.0`, React/ReactDOM 19.2.0, Vite 7.1.12 and Playwright 1.56.1. This uses the known-installable 0.14 pair, not the broken React + core 0.15 peer graph, and leaves the root 0.15 SDK parity baseline unchanged.
- **Real DOM interaction:** Vite mounts the published React `A2uiSurface` and Basic Catalog custom elements in Chromium. The local v0.9 fixture creates a surface with a Text data binding and Button. A Playwright pointer click emits `confirm-choice` with `selection=alpha`; an agent `updateDataModel` changes visible Text to `beta`; a real keyboard Enter emits a second event with `selection=beta`. Deleting the surface removes the Button and another Enter emits no stale event. No browser page errors or reported surface errors were observed.
- **Reproducible evidence:** `npm test --prefix renderer-react` runs the browser and local server and writes `renderer-react/out/react-browser-trace.json` and `renderer-react/out/react-browser.png`. The trace records four integration checkpoints, two exact action payloads, published installed versions and fixture SHA-256. `npm run build --prefix renderer-react` validates bundling. CI has an independent browser job and artifact upload.
- **Limits:** one Chromium/React/v0.9/Button sequence and late-delete guard; no established novel upstream defect, full invalid-action recovery, Lit/Angular comparison, complete accessibility testing or React 0.15 support. npm and Chromium installation need network; browser test execution afterward uses no LLM, paid infrastructure or third-party HTTP calls.

## E. Headless rejection/recovery trace (2026-11-07)

- Target: published `@a2ui/web_core@0.15.0` v0.9 `MessageProcessor`, not a browser or React.
- A 13-message, two-live-surface fixture includes three observed SDK rejections: an update for an uncreated surface, a create with an unknown catalog, and a stale update after a surface was deleted. All ten other messages apply.
- After each rejected message, the harness snapshots all previously seen surface IDs and emitted-action count. In these tested cases there was **no observed state/action mutation**. Later valid messages update the surviving surface, and recreation of the deleted ID starts with fresh components/data. This does not prove that all SDK internal state is unchanged.
- Per-event status, error origin and public surface state are exported via `npm run replay:recovery` to `out/recovery.json`; CI checks rejection positions and verifies identical snapshots at 1/7/57/full JSONL chunk sizes.
- This is application-level fault containment on a published SDK. It is not a claim of a new A2UI bug or an integrated browser-renderer recovery test. React failure injection and cross-renderer parity remain open.

## Transport-level UTF-8 byte chunk replay
The original `parseJsonLines` accepts JavaScript text chunks, not raw transport bytes (a `Buffer` was rejected with `TypeError: JSONL chunks must be strings`). The separate `parseJsonLinesBytes` now accepts published-SDK replay events split at arbitrary byte offsets, including inside UTF-8 code points. Decoding is strict/fatal, with enforced per-line byte and total message limits; invalid UTF-8, incomplete final lines, and oversized lines fail closed rather than silently changing data.

The localized fixture uses `Čebelica 🌍`, `こんにちは`, and `Здраво 👋`; six byte chunk sizes (1, 2, 3, 7, 57, full buffer) replay to identical actual `@a2ui/web_core@0.15.0` v0.9 MessageProcessor snapshots. `npm test` covers invalid inputs and resource boundaries; `npm run replay:demo` writes `out/replay.json` with byte-boundary trials for GitHub CI artifact inspection. This closes a limitation in **this project's test harness**; it does not establish a defect in the upstream SDK or prove browser renderer recovery.

## Text JSONL replay resource limits
Before hardening, `parseJsonLines` accepted a 2,060-byte newline-terminated JSONL frame under `maxLineBytes: 32` when 2,048 trailing spaces were trimmed before size validation. The affected parser is **our own harness**, not an upstream SDK vulnerability. The bounded parser now accounts for untrimmed UTF-8 line bytes as input arrives, including cross-chunk surrogate pairs and CRLF, and rejects more than `maxMessages` (default 10,000). Unit regressions confirm the original single-chunk and multi-chunk bypass is rejected, while published-SDK lifecycle snapshots remain identical. Tests run offline with `npm test`.

## Local captured-session replay
A standalone `src/replay-file.mjs --input capture.jsonl [--out report.json]` runner accepts user-supplied v0.9 JSONL offline, processes each message using the published pinned MessageProcessor, and emits a deterministic content-digest + lifecycle snapshot report without recording the original path. CI runs it on the included five-event JSONL sample and uploads the result as an artifact. The input boundary checks use raw bytes before JSON whitespace normalization and enforce 4 MiB per capture, 256 KiB per line and 10,000 total frames; strict UTF-8 and complete terminal newline are required. Unit tests reject padded-frame overflows, partial or malformed input, empty-frame floods and accidental evidence overwrite. This is local protocol replay, not browser-level fault recovery or independent evidence of an upstream defect; reports may contain sensitive state from the input.

## Integration handoff and dependency security

Automated PR integration is defined in docs/INTEGRATION.md. At the exact final verified PR head, include one line in the PR BODY: MERGER_HANDOFF: AKzar1el/a2ui-compat-lab@<full head SHA>. The A2UI-only GitHub Actions merger accepts only source/test/docs changes with fully green exact-head and main CI. Packages, lockfiles, workflows and security policies require owner review; never bypass this restriction. The separate shared fleet merger remains untouched.

A2UI SDK 0.14/0.15 currently depends on Zod 3.25.76 with an unresolved HIGH advisory. See SECURITY.md. npm audit gate discloses it and permits a narrow expiry-bound exception until 2026-12-07; any new vulnerability fails CI.

## Opt-in byte-boundary replay for user-provided captures (2026-11-07)

The local `src/replay-file.mjs --verify-chunks` path parses the same captured UTF-8 JSONL file at 1, 7, 57 and full-buffer byte chunk widths. It runs each decoded message sequence through the actual pinned `@a2ui/web_core@0.15.0` v0.9 MessageProcessor, compares observable component/data snapshots to the ordinary replay and fails closed on mismatch. The report records per-trial byte sizes and equivalence. Tests include split multibyte Unicode and a limit rejection without writing evidence; opt-in verification caps input at 512 KiB, while normal replay retains its 4 MiB cap. These are deterministic offline **harness-level byte-frame** tests, not an assertion that the SDK implements an incremental network transport parser or evidence of a new upstream defect.

## React Chromium invalid-catalog rejection and continuation (2026-11-07)

- The version-pinned published `@a2ui/react@0.14.0` / `@a2ui/web_core@0.14.0` browser harness now injects an unknown-catalog `createSurface` while a valid surface remains mounted. The test requires the published SDK to reject it, compares the before/after sorted surface IDs, components, data, surface errors and emitted actions, and confirms the visible Button remains mounted.
- After the rejected message, Chromium still performs the original real pointer click, agent data update, keyboard Enter and surface deletion. The machine-readable browser trace records five checkpoints, the rejected error name/message, and the unchanged-state assertion.
- GitHub Actions on source commit `848ef19b7e1a4f04b8acfcdcc500b115be0f7b0f`: [run 42376021157](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42376021157) passed `react-browser`, `sdk-parity`, and `dependency-audit` and published the `a2ui-react-browser-trace` artifact. This run was performed remotely, not in the older local checkout.
- Scope is one rejected catalog case in the actual React/Chromium integration, not a general renderer-fault guarantee or a new upstream defect. Zod3 security exposure remains documented separately in `SECURITY.md`.

## Interleaved multi-surface action isolation (2026-11-07)

- The offline Node regression `test/multi-surface-actions.test.mjs` replays a deterministic, real-published-SDK v0.9 Button fixture against **two simultaneously live surfaces with identical component IDs** through the existing `MessageProcessor` / `ComponentContext` / `GenericBinder` harness.
- It alternates action events and data updates, deletes one surface, recreates it under the same ID, and checks that five emitted actions retain the correct `surfaceId`, `sourceComponentId` and per-surface data-binding context. A stale Button action must reject while the second live surface remains actionable.
- The same observable action/state trace must hold when complete JSONL is decoded from 1-, 2-, 7-, 57-byte and full-buffer transport chunks. Run with the regular offline `npm test`; CI's `sdk-parity` job executes the regression on the published `@a2ui/web_core@0.15.0`.
- **Scope:** headless SDK action routing and lifetime isolation, not multi-surface React DOM rendering, visual accessibility, an upstream vulnerability, or evidence of a novel defect. Those integration and external-feedback milestones remain open.

## React Chromium simultaneous-surface action isolation (2026-11-07)

- The existing real Chromium/React v0.9 harness now mounts two independent published-SDK surfaces with identical `root`, `submit`, `label` component identifiers and the same `Confirm` Button label. The test first proves the original pointer and keyboard actions, then creates a second surface from the same pinned fixture.
- A real click on the second Button must emit `surfaceId=parallel-surface` with `selection=gamma`. Updating only the original surface to `selection=delta` must leave the parallel DOM text `gamma` intact. Clicking the original Button must emit `surfaceId=action-replay` and `selection=delta`, with the full action sequence checked exactly.
- Deleting only the parallel surface must detach its Button without deleting the original Button or emitting a stale action. A subsequent real pointer click on the surviving original surface must still emit the correct action. The pre-existing final surface deletion, keyboard, screenshot and page/runtime error checks remain active.
- First implementation revealed a **test-harness bug**: a Node-scoped `secondSurfaceId` was accidentally captured in a Playwright `page.evaluate` callback. The first [CI run](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42394936348) failed the browser job; the script now explicitly passes the ID into the page context. The corrected source-head [CI run](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42395020427) passed `sdk-parity`, `react-browser` and `dependency-audit`.
- This is integration coverage on the real pinned React/core 0.14.0 pair, not a demonstrated novel upstream SDK bug, Angular/Lit parity, or a guarantee of generalized asynchronous fault recovery. No local tests were run in the preserved historical checkout. The known Zod3 HIGH advisory remains unpatched under the existing temporary exception.

## E. Browser async stale-peer recovery (2026-11-07)

The published React/core 0.14 Chromium harness now tests deterministic queued-message failure after two simultaneous Button surfaces: delete `parallel-surface`, deliver a late `updateDataModel` for that deleted ID on a microtask, then deliver a valid `updateDataModel` to the still-mounted `action-replay` surface on the next microtask. The SDK rejects the stale message and accepts the valid update; the rejected attempt leaves the survivor's prior data intact. Playwright asserts that the surviving DOM shows the fresh value, the deleted peer does not reappear, no action fires from message delivery alone, and a real keyboard Enter emits the next action with the survivor's fresh data.

Source-head CI [42415106881](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42415106881) passed `sdk-parity`, `react-browser` and `dependency-audit` on source commit `66218ff25dd87a796097d5505588434312c34c3c`. This exercises ordered asynchronous message delivery through a browser-mounted renderer; it is **not** evidence of a concurrent-thread race, an undisclosed upstream defect, generalized async cancellation, customer demand, or a fixed Zod3 dependency.

## E. React Chromium same-ID surface recreation (2026-11-07)

The published React/core 0.14.0 Chromium regression now covers deletion and **recreation of the same surface ID** after asynchronous stale-peer rejection. The renderer receives a fresh `parallel-surface` using the same `root`/`submit` component IDs and `Confirm` Button label. Playwright asserts that the new peer renders `selection=reborn`, the earlier `gamma` data is absent, and the surviving original still shows `epsilon`. A real pointer click on the recreated Button must emit `surfaceId=parallel-surface` with `selection=reborn`; deleting it a second time must leave the surviving Button and action log intact. This directly guards against stale React bindings or unintended state reuse across surface recreation.

The exact source commit `4eb99c567bb20ec4060f735be2768a143d715f09` passed all required GitHub Actions jobs at [run 42419248665](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42419248665): real React Chromium, sdk-parity (including pinned Python parity), and dependency-audit with only the documented unresolved Zod3 HIGH exception. This is **a passing regression**, not a new observed upstream defect, a Lit/Angular cross-renderer claim, or evidence of customer demand. The historical local checkout was not modified or tested.

## React Chromium recreated peer keyboard Tab/Space (2026-11-08)

- The real pinned React/core 0.14.0 Chromium regression now focuses the surviving Button, navigates with **Tab** to the peer recreated under the same surface and component IDs, and activates it with **Space**. The emitted action must carry the recreated peer's `surfaceId=parallel-surface` and fresh `selection=reborn` rather than the survivor's state. A second deletion followed by Space must emit no stale action.
- Source commit `b4d81b1f10ea2d2177d47eca01f05c05077b8938` passed [GitHub Actions 42433028248](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42433028248): `sdk-parity`, `react-browser`, and `dependency-audit`. This is a real browser keyboard interaction on the published packages, not an isolated DOM mock or proof of novel upstream failure.
- The initial local checkout and untracked renderer files were preserved; **no local tests ran**. Only the documented unresolved Zod3 HIGH exception is permitted by the dependency gate. Keyboard navigation in this Button fixture does not establish full WCAG conformance, screen-reader support or Lit/Angular parity.

## F. Browser-visible UTF-8 JSONL delivery and action binding (2026-11-08)

- The existing real Chromium integration harness reconstructs three v0.9 `updateDataModel` messages from UTF-8 JSONL chunks of **1, 7 and 57 bytes**, including Unicode selection values (`café 🍵`, `música 🚀`, `über 🎯`). A fatal UTF-8 `TextDecoder` holds split characters across byte boundaries; only newline-complete JSON messages are passed into the published `@a2ui/web_core@0.14.0` `MessageProcessor`.
- Each case asserts no state mutation before a complete message, exactly one applied message, no unsolicited agent action, updated **visible React Text**, and a real Playwright pointer click on the surviving published React Button yielding exactly the updated selection and component/surface routing. The renderer still runs offline against the exact published React/core 0.14.0 pair.
- The byte framing is **test harness code**, not an A2UI SDK-provided transport parser. This provides a reproducible application-level streaming/DOM interaction contract, **not** evidence of an upstream decoder defect, tested network socket behavior, or multi-renderer compatibility.
- Verification: [source-head GitHub Actions CI](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42437134952) passed `sdk-parity`, `react-browser`, and `dependency-audit` on commit `24cfa120d446f50a51c2f19374a310d29d20e0cd` (the dependency gate retains its narrowly disclosed unresolved Zod3 exception). Local tests were not executed because the canonical checkout contains historical untracked renderer files.

## F. Browser recovery after a malformed JSONL frame (2026-11-08)

- Extended the same published React/core 0.14.0 Chromium integration on PR #23. The test-harness UTF-8 JSONL decoder receives one **complete but syntactically malformed** frame followed by a separate, valid Unicode `updateDataModel` frame, delivered in 3-byte chunks.
- Assertions require exactly one parsing rejection, no mutation of the published SDK model at rejection, exactly one subsequent SDK update, no unsolicited action, visible React Text with the recovered selection, and a real Chromium Button click with that fresh value and correct surface/component IDs. The error handler catches only JSON `SyntaxError`; other errors still fail the regression.
- The parser and framing code live in the **test harness**, not in the published A2UI SDK; this is an application-level transport recovery contract, **not** evidence of an SDK decoder fix or a newly discovered upstream defect.
- Source commit `8751863574de41e6fea599fe6337c1685062faad` passed [GitHub Actions CI 42441779497](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42441779497), including real Chromium `react-browser`, Node/Python `sdk-parity` and `dependency-audit` with the single documented unresolved Zod3 HIGH exception. This was **GitHub-only CI**; the historical Windows checkout and its untracked renderer files were not modified or tested locally.

## F. Real React streamed surface create/action/delete lifecycle (2026-11-08)

- Existing [PR #23](https://github.com/AKzar1el/a2ui-compat-lab/pull/23) extends the pinned published React/core 0.14.0 Chromium regression beyond streamed data updates: an independent v0.9 `createSurface`, `updateComponents`, and `updateDataModel` sequence is framed as newline-delimited UTF-8 and delivered in **5-byte chunks**. The test asserts exactly three SDK applications in their original order, complete framing, visible `lifecycle 🌱` React Text and two independently mounted Buttons. Message delivery itself must emit no action.
- A real Playwright pointer click on the newly streamed surface must emit exactly one `confirm-choice` action with the correct surface/component identifiers and fresh `lifecycle 🌱` value. A `deleteSurface` message framed in **2-byte chunks** must detach that surface without removing the original or dispatching an extra action.
- [Source-head CI 42445891290](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42445891290) passed all three required jobs: `sdk-parity` (Node/Python), actual `react-browser` Chromium and `dependency-audit` with the existing unresolved Zod3 HIGH exception. Source commit: `3d2c2d3795f5b099e1dd5bef5b86e2e0650ecac8`. This validation was **GitHub Actions only**, not local testing.
- UTF-8 decoding and JSONL framing are still **application test-harness code**, not published A2UI transport APIs; the result does not establish a new upstream bug, tested network transport, cross-renderer parity, or complete accessibility coverage.

## G. Private local capture failure diagnostics and bounded scan inputs (2026-11-08)

- The local `src/replay-file.mjs` runner processes potentially confidential JSONL capture content. JavaScript JSON parser exceptions and published SDK rejection exceptions may include literal fragments or user-controlled surface IDs. The CLI now emits fixed stage-specific errors for UTF-8 decoding, JSONL parsing, SDK replay and optional byte-chunk verification; it does not print the captured values on these failure paths. This changes **our CLI**, not the upstream SDK. Successful replay reports still intentionally contain captured state and must remain private.
- The offline `src/cli.mjs compare` scan comparison now limits each JSON input to a regular 1-byte-to-8-MiB file and refuses malformed JSON with a generic diagnostic rather than Node's parser excerpt. These limits do not affect `scan`, `doctor`, or the separate release matrix.
- Offline subprocess regressions supply deliberately malformed captures and a missing-surface SDK message with private markers, then assert failure without marker leakage or a written report. Scan comparison tests both `--before` and `--after` malformed inputs plus an over-8-MiB report. This checks user-facing failure handling, not a new published A2UI compatibility disagreement or an external security incident.
- All source, tests and evidence were changed **through GitHub only** to preserve the historical untracked Windows renderer directory. GitHub Actions remains the required validation channel; no local test execution is claimed. The separate unresolved Zod3 HIGH advisory and its December 7, 2026 exception are unchanged.


## 2026-11-08 — Report byte-integrity regression (remote-only candidate)

Local scan and A2UI capture/action comparison reports are evidence, not permissive text. Node's `readFileSync(path, 'utf8')` silently replaces malformed UTF-8 bytes with U+FFFD; a damaged report can therefore remain syntactically valid JSON and be incorrectly treated as valid comparison input. The scan comparator and the capture/action comparator now use fatal UTF-8 decoding before JSON parsing and fail closed with content-redacted diagnostics.

Deterministic regressions insert a malformed UTF-8 byte into an otherwise valid report's implementation string and verify refusal for before, after and self-comparison inputs. This tests transport/report integrity, **not** a newly discovered A2UI SDK vulnerability. Published-SDK fixture and real browser test coverage remains unchanged. GitHub CI is the sole source of validation for this GitHub-only change; no local Windows tests are claimed.

## React interleaved live-surface update burst (2026-11-08)

The published React 0.14 / core 0.14 Chromium harness now includes a bounded
six-message agent-update burst interleaved across two simultaneously mounted
surfaces, followed by an actual pointer Button click and keyboard Enter.
It asserts that neither the original nor peer React Text displays stale
intermediate data; mere agent updates emit no actions; and each real action
uses its own surface's final data despite reused component IDs. It then
deletes the keyboard-focused peer and asserts that no stale action is emitted.

This is an application-level integration regression, not an upstream SDK
defect claim. Microtasks run in deterministic delivery order, so this does
not establish behavior for truly concurrent network writers or additional
renderer frameworks. CI's `react-browser` job supplies the real Chromium
execution proof; local checkout tests are not claimed.

## Comparison report output preserves prior evidence (2026-11-08)

The local `compare --before ... --after ... --out ...` CLI previously used normal
`writeFileSync` semantics for its output, so selecting the same path as either
input silently replaced a source scan report with a comparison report. It could
also overwrite an earlier comparison artifact. Such replacement destroys the
original bytes needed to reproduce an SDK baseline comparison.

The comparison output now uses atomic exclusive-create (`wx`) on the resolved
destination, rejecting **any** existing file (including matching input paths,
symbolic links and existing report paths) without altering those bytes. The
subprocess regression checks both input collisions, an unrelated existing
output, successful new output, and an attempted second write to that output.
It does not change the historical overwrite contract of `scan` or `releases`,
the published SDK behavior, or the existing pinned dependency versions.

Validation requires final-head GitHub Actions `sdk-parity`, `react-browser`, and
`dependency-audit`. The Windows source checkout retains historical untracked
renderer files and is not used for local testing. The known Zod3 HIGH advisory
remains **unresolved** under its December 7, 2026 exception; this work does not
claim a new upstream A2UI compatibility defect or solve that advisory.

## Fail-closed offline CLI option parsing (2026-11-08)

The lab's local report CLI previously accepted repeated `--before`, `--after`
or `--out` flags and silently retained the last value. It also treated a
following flag token as a filename, e.g. `scan --out --strict` could create
a file literally named `--strict` and run without strict checking. This is
ambiguous evidence handling in **our CLI**, not an upstream A2UI SDK defect.

The parser now refuses duplicate switches and valued options, and rejects
missing or flag-looking values before performing scans or file I/O.
A filename beginning with `--` can still be supplied explicitly with a
relative prefix such as `./--report.json`. Offline subprocess regressions
cover duplicate input/output options, duplicate boolean switches and flag
tokens mistaken for paths, asserting nonzero exit, no JSON stdout and no
unintended artifact. No changes to A2UI packages, dependency policies,
security exceptions, CI workflows, or the historical normal `scan` output
overwrite contract. The historical Windows checkout remains untouched;
verification is exclusively through exact-head GitHub Actions.

## Fatal UTF-8 corruption and live React recovery (2026-11-08)

The existing published `@a2ui/react@0.14.0` / `@a2ui/web_core@0.14.0`
Chromium integration now includes a negative raw-byte transport frame:
a multibyte emoji continuation byte is corrupted in a complete JSONL
`updateDataModel` message. The browser-side `TextDecoder` with `fatal: true`
must reject that frame **before SDK delivery**, with the mounted A2UI model,
DOM and action history unchanged. After replacing the failed transport
decoder, a separately framed, valid Unicode update must render in the live
React surface and a real pointer click must emit the updated action context
exactly once. The trace records an `invalid-utf8-transport-recovery`
checkpoint and does not include user data.

This tests fail-closed framing and recovery in **our application transport
harness** coupled to a real browser and published A2UI renderer. It does not
claim that the A2UI SDK itself implements a byte parser, has an unreported
UTF-8 vulnerability, or supports arbitrary resynchronization within a
corrupted stream. The explicit reset boundary is required. Validation is
via the final-head GitHub Actions `react-browser` job; the historical Windows
checkout was not used to run local tests. SDK dependencies, CI and the
unresolved narrow Zod3 exception are unchanged.

## Live React component-graph replacement and event rebinding (2026-11-08)

The published `@a2ui/react@0.14.0` / `@a2ui/web_core@0.14.0` Chromium
replay now replaces the mounted original surface's component graph: its
`Confirm` Button is removed from the rendered DOM and a newly identified
`Confirm replacement` Button is introduced with a different A2UI action
name. The regression asserts no event on the component-only update, verifies
one real pointer event from the new Button, then updates the model and
verifies a keyboard Space event from that Button carries the latest bound
data. Neither stale source-component IDs nor old event names are allowed in
the resulting action trace.

This is actual browser/SDK application integration behavior beyond a
standalone schema-conformance check. It does not establish compatibility
with Lit/Angular, a security vulnerability or a discovered upstream SDK bug.
Verification comes only from exact-head GitHub Actions `react-browser`;
the original Windows checkout is not modified or locally tested. The known
Zod3 HIGH exception and installed SDK pins are unchanged.

## Stable-ID React Button event hot-swap (2026-11-08)

The isolated published React/core 0.14.0 Chromium regression now exercises an
`updateComponents` event replacement where a mounted Button **retains the same
component ID** (`new-submit`) while its action name and Text child change.
This differs from the earlier new-component-ID replacement regression: DOM
reconciliation can reuse a component and must not retain its former event
binding. The test requires the obsolete button label to disappear, exactly one
Button to remain, and no synthetic action from the update. A real pointer
click must emit `confirm-hot-swap` (not the former event); a subsequent
`updateDataModel` and keyboard Space must emit the same new event with the
latest model value and original surface/component IDs. The existing final
surface-deletion guard still checks no stale action can be emitted.

This is a deterministic application-level integration regression using pinned
published SDKs and real Chromium, not an upstream defect claim or coverage for
other renderers. The change is committed remotely through GitHub to preserve
historical untracked Windows files; final-head GitHub Actions `react-browser`,
`sdk-parity` and `dependency-audit` results are required before handoff.
No local test execution is claimed. The known Zod3 HIGH advisory and its
expiry-bound 2026-12-07 exception remain unresolved.

## Focused Button detachment and same-ID reinsertion (2026-11-08)

The published `@a2ui/react@0.14.0` / `@a2ui/web_core@0.14.0` real-Chromium integration now exercises a temporary component-only removal of a **keyboard-focused** Button while its surface and bound Text remain mounted. The test requires the Button to detach, the Text to remain visible, and a subsequent Space keypress to emit no stale action. A later `updateComponents` reuses the same Button/component ID but assigns a *new* event (`confirm-restored`), followed by a real pointer click and a keyboard Enter after a model update. Both interactions must carry only fresh event names and model values without duplicate controls or runtime errors.

Unlike the preceding component replacement and hot-swap checks, this covers the **zero-Button interval** and reattachment of a previously detached component ID within the same live surface. It is a deterministic application-level renderer regression, not a newly demonstrated upstream SDK defect or a guarantee for other browsers/renderers. Source is edited remotely to preserve the historical untracked Windows renderer directory; **GitHub Actions `sdk-parity`, `react-browser`, and `dependency-audit` at the final PR head** must confirm execution. No local tests are claimed. Pinned dependencies, workflow/security rules, and the unresolved Zod3 HIGH exception through 2026-12-07 are unchanged.

## 2026-11-08 — Agent-controlled Text markup containment (GitHub-only candidate)

- Added a deterministic real-Chromium React 0.14/core 0.14 replay assertion for agent-provided `updateDataModel` Text containing an HTML-looking image with an inline `onerror` assignment and an offline `data:` source. The browser regression requires no executable `onerror` DOM attributes, no execution of that handler and no synthetic agent actions from rendering. A genuine Playwright pointer click must still emit the existing Button event with the **exact original markup string** as data.
- This protects the application boundary between untrusted model data, browser DOM rendering and event context. It does **not** claim that published A2UI has an XSS vulnerability, that all HTML injection vectors are covered or that the A2UI SDK is patched. The upstream dependency advisory GHSA-mrhx-c7xc-m3w5 remains separate and unresolved.
- Changes were authored using GitHub-only APIs because the historical local checkout has untracked `renderer-react/` files; local tests were not run. At final PR head, require GitHub Actions `sdk-parity` (including Python), `react-browser` (real Chromium) and `dependency-audit` (documented narrow Zod3 exception) before exact-SHA merger handoff.

## 2026-11-09 — Replay fixture report output integrity (GitHub-only candidate)

The three committed offline published-SDK fixture report commands (`replay-report`,
`replay-action-report`, and `recovery-report`) previously used ordinary
file writes for `--out` (and two silently ignored unknown CLI arguments).
They now share strict `[--out FILE]` parsing and exclusive file creation:
an existing report or symlink destination cannot be overwritten, and invalid
or duplicate flags cannot publish artifacts. Standard JSON stdout remains
unchanged. Deterministic subprocess tests exercise each command's real
published-SDK output, exact stdout/file equivalence, invalid options and
repeat-run refusal. This protects local evidence provenance, not a claimed
upstream A2UI defect. GitHub Actions only; no Windows-local test claimed.
The pinned Zod3 advisory remains unresolved with its 2026-12-07 exception.

## React browser harness loopback isolation (2026-11-09)

- Real Chromium replay now uses an OS-assigned ephemeral Vite port on `127.0.0.1` instead of a fixed port 4181, avoiding avoidable port contention in parallel local runs.
- The Playwright browser context blocks service workers and denies HTTP(S) page requests outside the active local Vite origin. A deterministic fetch to a **different loopback port** must be intercepted, and subsequent real Button/data/surface interactions must make no unexpected off-origin HTTP(S) requests.
- The request guard is part of the pinned `@a2ui/react@0.14.0` / `@a2ui/web_core@0.14.0` Chromium regression. It does **not** prove general-purpose sandboxing or cover non-HTTP requests, external tools or all WebSocket traffic. No remote service is needed during test execution after installation.

## Core CLI report provenance: no silent overwrite (2026-11-09)

- The top-level `scan`, `doctor`, `compare` and opt-in network-dependent `releases` commands now use atomic exclusive creation for `--out` JSON evidence. Previously only `compare` refused to overwrite an existing report; the other three could silently erase prior evidence. This aligns the core CLI with the already-protected replay report CLIs.
- Deterministic offline subprocess regressions run the real published-SDK `scan` and offline `doctor` twice with the same target, assert the second invocation rejects with exit code 2 and produces no success output, and require byte-for-byte preservation of the first JSON artifact. The shared write path also covers `releases` without invoking the npm registry during tests.
- Scope: local JSON report provenance, not a new upstream A2UI defect. It does not attempt to protect arbitrary network/filesystem resources; no SDK, dependency, workflow, merger or security policy changes.

## React Chromium console-error observation (2026-11-09)

The real React browser harness previously listened for uncaught `pageerror` exceptions but not ordinary `console.error` diagnostics. Those are different browser signals: a React/component warning logged as an error can leave the page mounted and all existing DOM/action assertions green. The harness now subscribes to Chromium console errors before navigation, triggers one controlled `console.error` marker to prove collection works, and fails if any other startup error is present. It clears the known marker, separately verifies and clears the single `net::ERR_FAILED` diagnostic emitted by the intentionally aborted off-origin HTTP probe, and requires zero unrelated console errors throughout the actual A2UI UI/action lifecycle; the JSON trace records `consoleErrors` and probe-observed checkpoints. This tests downstream observability, not a newly discovered A2UI vulnerability or a claim of full browser error coverage. Network guard, SDK version pins and existing action assertions are unchanged.

## Browser replay evidence publication guard (2026-11-09)

- The published React/Chromium replay previously wrote `out/react-browser.png` before its final markup-containment, surface-deletion and console assertions, then unconditionally overwrote `out/react-browser-trace.json`. A failing subsequent assertion could leave a new screenshot without a successful trace, and a second execution could replace an earlier successful trace.
- The runner now captures the mounted-surface screenshot in memory and publishes both files only after the complete replay passes. It checks for an existing output directory before starting Chromium and creates a fresh output directory exclusively at publication time; no older screenshots, traces or user files are deleted or replaced. A second run must explicitly choose `--out-dir run-2` (or another fresh simple directory name) to preserve prior evidence.
- Offline Node unit tests exercise invalid directory arguments, failure-path no-publication, successful JSON/PNG emission and existing-output preservation. The real Chromium CI job remains the authoritative validation of the published pinned React SDK behavior. This is test-harness evidence integrity, not a newly found upstream A2UI defect.

## Real Chromium nested model leaf update and action binding (2026-11-09)

- Earlier browser assertions updated the entire `/` data model while Text and Button context bindings dereferenced `/selection`. A valid leaf-only update could therefore affect actual UI/action behavior without being caught by the original root-replacement cases.
- The new offline-after-install Chromium regression sends a v0.9 `updateDataModel` at `/selection` through the published pinned `@a2ui/web_core@0.14.0`, checks that React Text shows the new Unicode value, asserts that the unchanged `confirmed` sibling survives, and verifies that the model update itself emitted no action. A real keyboard Enter must then emit exactly one `confirm-restored` action containing the fresh leaf value rather than a stale binding.
- The test exercises an integrated published React renderer and event action, not just JSON Schema conformance. GitHub Actions `react-browser` remains the authoritative real-browser gate; `sdk-parity` and `dependency-audit` must also pass at the exact final PR head. It is not evidence of a newly identified upstream defect or additional customer demand.
## Real Chromium explicit empty selection leaf (2026-11-09)

- The existing published @a2ui/react@0.14.0 / @a2ui/web_core@0.14.0 real Chromium test now sends updateDataModel to /selection with an explicit empty string, after a prior non-empty Unicode leaf update. The regression verifies that the old rendered Text disappears, the sibling confirmed field stays intact, and no agent action fires merely from model delivery.
- A real focused Button keyboard Enter must emit confirm-restored with context.selection equal to "", not the prior value or a missing key. This checks that a valid falsy data value is not mistaken for absence and that event context is fresh; it is a browser interaction contract, not an upstream conformance suite duplication.
- Source-head [GitHub Actions 42578919823](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42578919823) passed sdk-parity (including pinned Python), real Chromium react-browser and dependency-audit with the existing narrow Zod3 HIGH exception. Final journal-inclusive PR-head CI still must be checked before merger handoff. No local tests were run because the historical Windows checkout retains untracked renderer-react/.
- This is a passing pinned-version regression, not a discovered upstream bug, full accessibility validation or evidence of commercial demand. The Zod3 GHSA-mrhx-c7xc-m3w5 is still unresolved; the existing exception expires on 2026-12-07.

## 2026-11-09 — Falsy scalar action context + actual final Button teardown

- On the pinned, published `@a2ui/react@0.14.0` + `@a2ui/web_core@0.14.0` Chromium surface, a live Button rebind now includes `/count` and `/enabled` along with `/selection`. A real pointer click must emit explicit `count: 0` and `enabled: false`, while preserving the selection; these are values, not missing context fields.
- Two leaf updates (`/count = 3`, `/enabled = true`) must preserve other model fields without generating an action. A real keyboard Space press must then emit the updated scalars. The final delete assertion now watches the **last currently mounted Button**, not the obsolete initial `Confirm` locator, so an orphaned live Button cannot falsely pass the teardown.
- Source commit `1f49fe81f56b2b0b43cc031c663ca64c5ba17982` passed all three jobs in [GitHub Actions run 42585000097](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42585000097): sdk-parity (including Python), real Chromium react-browser, and dependency-audit with the pre-existing narrow Zod3 HIGH exception. The tests are offline by default and add no dependencies. This establishes a covered integration case, **not** a previously unknown SDK defect, new customer demand, or a Zod remediation.

## 2026-11-09 — Real React nested-object JSON Pointer binding

- On the published, peer-compatible React/core `0.14.0` Chromium harness, Text and a Button action context resolve the nested path `/form/label` in a model with a separate `form.retained` sibling, unrelated root fields and an explicit empty-string selection.
- The first real pointer click sends the initial nested value (`before 🌿`); an SDK `updateDataModel` at `/form/label` refreshes visible Text to `after 🧭` without replacing sibling fields or synthesizing an action. A real keyboard Enter emits the updated nested value and preserved empty selection, rather than the original context.
- Source-head GitHub Actions [42593769316](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42593769316) passed Node/Python `sdk-parity`, the real `react-browser` job and `dependency-audit` with the previously documented unresolved Zod3 exception. Exact final PR-head CI must be verified separately.
- This is reproducible passing application-level regression coverage, **not** evidence of a new upstream A2UI bug, a complete accessibility suite or external customer demand. Historical Windows checkout and untracked `renderer-react/` remain untouched; no local tests were performed.

## 2026-11-09 — Real Chromium TextField two-way model/action replay

The pinned published `@a2ui/react@0.14.0` and `@a2ui/web_core@0.14.0`
now participate in an application-level **form** regression rather than only
agent-generated Button/Text replays. A real Playwright `fill` on a mounted
`TextField` bound to `/form/label` must update the published data model,
refresh a separately bound React `Text`, preserve `form.retained` and the
root siblings, and **not** synthesize a server action. A genuine pointer
click must emit exactly one Button event carrying the browser-edited value.
A subsequent agent `updateDataModel` to the same leaf must update both
the visible Text and live input; a keyboard Enter on the Button must carry
the new agent value, not the prior user input. This exercises the official
v0.9 [two-way data-binding contract](https://a2ui.org/concepts/data-binding/)
through real Chromium and the published SDKs.

**Observed accessibility limitation:** The initial
[PR #43 CI run 42600081128](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42600081128)
timed out on `getByRole('textbox', {name: 'Edit form label'})`. A targeted
[diagnostic run 42600261672](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42600261672)
confirmed that the actual rendered `<input>` has an empty `id` and no
`aria-label`, despite the A2UI `TextField.label` property. The form
regression now locates its single real textbox by role without an accessible
name and continues to enforce its actual two-way data/action behavior.
This is a **specific observed accessible-name gap** in the pinned release
pair, not a claim of comprehensive accessibility coverage or a newly proven
security issue. Follow up with an independently minimized upstream case
rather than silently treating the missing label as acceptable. The
[source-head GitHub Actions run 42600405193](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42600405193)
passed `sdk-parity` (including Python), `react-browser` and
`dependency-audit` under the existing narrow unresolved Zod3 HIGH
exception expiring 2026-12-07. All tests ran on GitHub; the original
Windows checkout was not changed or tested locally.

## Real Chromium TextField accessible-name telemetry (2026-11-09)

- Pinned published `@a2ui/react@0.14.0` and `@a2ui/web_core@0.14.0` stay unchanged. The real Chromium `TextField` fixture specifies `label: 'Edit form label'`; the browser regression now checks its actual named-textbox role using Playwright's accessible-name matching, retains the browser's `ariaSnapshot()`, and repeats the role check after an agent-driven `/form/label` update.
- A missing accessible name is published as a **non-blocking** `accessibilityFindings[]` warning with expected name and observed role snapshot. The separate `textfield-accessible-name-probe` checkpoint records name resolution before and after the model update. The test fails if the naming behavior unexpectedly changes across that live re-render or multiple named inputs appear; it does not suppress functional replay failures. A successful overall functional test is **not** an accessibility pass.
- Previous [PR #43](https://github.com/AKzar1el/a2ui-compat-lab/pull/43) exposed a real missing-name observation for this published React renderer. The new source-head [GitHub Actions run 42607567672](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42607567672) passed `sdk-parity` including Python, `react-browser` in real Chromium, and `dependency-audit` with only the time-bounded unresolved Zod3 exception. The browser artifact now carries the structured probe for downstream evidence consumers; no local tests are claimed.
- This observes an integrated renderer accessibility discrepancy; it does not modify the upstream SDK, establish a security vulnerability, or prove that every input/catalog variant is mislabeled. Follow up with a minimized upstream reproduction and check a compatible release before considering a fix or stricter gate.

## 2026-11-09 — Concurrent real Chromium TextFields with duplicate component IDs

- On pinned published `@a2ui/react@0.14.0` and `@a2ui/web_core@0.14.0`, the React browser harness mounts **two simultaneous forms on independent surfaces** with the same `root/status/editor/new-submit` component IDs and `/form/label` binding. A real Chromium text edit on either surface must preserve the other surface's visible field value and primary model state; merely editing must not dispatch a synthetic server action.
- Clicking each form's real Button must emit its own `surfaceId` and the newly entered value. Deleting the peer must detach both its TextField and Button while a genuine Enter key on the survivor still sends its latest model context. This complements existing duplicate-ID Button coverage with two-way user-input/model isolation, rather than repeating upstream conformance cases.
- [Diagnostic CI 42614898883](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42614898883) initially failed on Playwright strict-mode ambiguity: the old unscoped single-form `getByRole('textbox')` matched both valid mounted inputs. The primary locator was scoped to `.first()`; the behavioral assertions remain strict. [Source-head CI 42615036163](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42615036163) passed `sdk-parity` (including actual published Python 0.5.0), `react-browser` (real Chromium), and `dependency-audit` under the existing narrow unresolved Zod3 HIGH exception ending 2026-12-07.
- This is a passing deterministic application-level test, not proof of a previously unknown upstream defect, remediation of the documented TextField missing-accessible-name gap, or user/revenue traction. No Windows-local tests were executed; the historical local untracked `renderer-react/` directory was preserved.

## 2026-11-09 — Real Chromium TextField surface-ID recreation

- The pinned published React/core 0.14.0 browser harness now reuses a **deleted** A2UI v0.9 form's exact surface ID and component IDs, but with a fresh nested data model and a different Button event definition. Real Chromium must mount a new TextField with its new agent value, not the previous user's typed string, and must keep the surviving independent form unchanged.
- The harness's diagnostic `window.__a2uiLab.trace(surfaceId)` now supports a surface ID while retaining its default primary-surface behavior. This permits direct validation that the recreated peer model starts fresh, retains its unrelated nested sibling across a leaf update, and disappears on a second delete. Keyboard Enter and pointer click must emit exactly one action each under the **new** event name with current data, not stale pre-deletion context.
- Source-head [GitHub Actions 42625949247](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42625949247) passed all three required jobs: published SDK/Python parity, actual Chromium `react-browser`, and `dependency-audit` subject to the existing narrow unresolved Zod3 HIGH exception expiring 2026-12-07. PR [#46](https://github.com/AKzar1el/a2ui-compat-lab/pull/46) adds only source/tests and this evidence/journal; final docs-inclusive exact-head CI must still be verified before integration.
- This is a deterministic integrated application regression, **not** a newly proven upstream SDK defect, complete cross-renderer conformance, a fix for the existing TextField accessible-name discrepancy, or evidence of paying users. No local Windows/npm/Python/browser tests were run; the historical untracked checkout remains untouched.

## 2026-11-09 — Offline comparison of actual Chromium replay traces (PR #47)

- Previously the browser harness recorded real React/core v0.14 Chromium UI checkpoints, action context and accessibility findings, but SDK-upgrade reviewers had no direct way to detect observable differences between two saved reports. The new `src/browser-trace-compare.mjs` compares two schema-v1 trace JSON reports offline, with no browser, registry or paid service access.
- It **requires the same fixture SHA-256** before comparing ordered actions, checkpoints, runtime/console errors, accessibility findings and the replay pass flag. SDK versions are recorded as provenance rather than automatically treated as regressions. Candidate reports with an unsuccessful replay or runtime/console errors cannot report an OK comparison.
- The diff returns changed counts and bounded indices, not original user action-context strings. Both input traces are read-only and limited to 8 MiB each; malformed/incomparable input fails closed. The optional output report uses exclusive file creation. `--strict` exits 1 for drift and 2 for invalid evidence. This is a trace comparison, **not a new Chromium run, proof of source authenticity, official conformance certification or evidence of a new upstream defect**.
- Offline Node tests cover byte-stable semantic comparison despite object-key ordering, version-only changes, observable UI/action/accessibility/errors drift, mismatched fixture rejection, malformed private-input redaction, strict exit semantics and report no-overwrite. Source-head GitHub Actions [42643254447](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42643254447) and PR [42643310828](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42643310828) passed sdk-parity including published Python, real Chromium react-browser and dependency-audit under the pre-existing narrow unresolved Zod3 exception. Exact journal-final PR-head CI remains required before handoff.
- The historical Windows checkout retained untracked `renderer-react/` and was not edited or locally tested. No manifest/lockfile, workflow, merger configuration or security exception was changed; Zod3 HIGH expiry remains 2026-12-07.

## 2026-11-09 — Browser trace comparison rejects incompatible harnesses and malformed evidence (PR #48)

- The prior offline comparison required matching fixture SHA-256 but did not check the actual renderer/harness label. Two differently produced traces with identical serialized observations could incorrectly report `MATCH`; malformed `versions`, `actions`, error arrays, or accessibility findings also passed shape validation.
- The comparator now requires the same nonempty rendering harness and validates published package-version strings, action names, string browser errors, checkpoint steps and accessibility finding IDs. Missing/invalid fields fail closed with a redacted schema error; a changed harness is `incomparable`, not behaviorally equivalent. No action payloads or candidate secrets are printed in errors.
- The first [CI 42652617164](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42652617164) correctly failed the existing comparator tests because their synthetic finding omitted the real published browser artifact's `id` field. The fixture was corrected to match the actual Chromium recorder. The corrected source [CI 42652862412](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42652862412) passed `sdk-parity` including actual pinned Python, real Chromium `react-browser`, and `dependency-audit` under the existing narrow unresolved Zod3 exception.
- This is a reproducible validation gap in the lab's own offline trace-comparison tool, **not** an upstream A2UI flaw, a new real-browser fixture test, authenticated provenance or external user traction. All implementation/test verification was GitHub-only; the historical Windows checkout and untracked `renderer-react/` were untouched. Source documentation and receipt-inclusive final-head CI must be verified separately.

## 2026-11-09 — Real Chromium PNG-only visual evidence drift (PR #49)

- The offline browser comparator previously missed a UI change when Text checkpoints, actions, runtime/console errors and accessibility findings were identical, even though the real Chromium harness already captured a screenshot. Pinned React/core `0.14.0` now records the SHA-256 of the in-memory mounted-surface PNG and confirms the emitted PNG matches that report digest.
- `src/browser-trace-compare.mjs` compares that optional digest as one additional source of observable drift. Different PNG digests fail strict comparison even if all existing evidence fields match; a modern/legacy pair with only one digest also fails closed. Two legacy reports lacking digests remain comparable but explicitly identify `visualEvidence: legacy-unavailable`. Malformed digests are rejected without echoing potentially sensitive report content.
- Offline Node regressions prove screenshot-only drift detection, equal-digest matches including uppercase hex, partial legacy/new incompatibility, backward compatibility and malformed-input rejection. The real GitHub Actions Chromium job checks that the published PNG matches its trace digest. Source commit `77f31db3eefc206019776cc20a8e364938e8fa29` passed [push CI 42662243593](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42662243593) and [PR CI 42662284117](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42662284117), including SDK/Python parity, real Chromium and the existing dependency-audit exception.
- This is **raw PNG byte comparison**, not a pixel diff, visual similarity score, authenticated trace provenance, comprehensive browser regression or new upstream A2UI vulnerability. PNG encoding differences may create false-positive drift. The screenshot is captured at one mounted-surface point, not after all later steps. Existing Zod3 HIGH GHSA-mrhx-c7xc-m3w5 remains unresolved under the narrow exception ending 2026-12-07. No dependencies, lockfiles, workflows or merger/security policy changed.

## 2026-11-09 — Bound stored Chromium PNGs to their trace hashes (PR #50)

- Previously, comparing two trace JSON reports could return `MATCH` even if a separately saved screenshot PNG was modified afterward, because the recorded SHA-256 string did not verify the saved image. New paired `--before-png` and `--after-png` flags validate both actual image files against the trace digests before the CLI can report a match.
- A bounded offline verifier accepts only regular files (not symlinks) of 8 bytes to 32 MiB, checks the PNG signature, hashes the exact bytes, and requires matching SHA-256. Missing legacy digests, incomplete paired flags, altered bytes, and invalid signatures fail with exit 2 and sanitized diagnostics. JSON-only comparisons remain supported with `pngArtifactsVerified: false`; successful explicit verification sets it to true.
- Deterministic Node subprocess regressions cover valid PNG pairs, changed screenshots with unchanged JSON, fake non-PNG files, incomplete flag pairs, and legacy traces missing image digests. Source-head [PR CI 42672969039](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42672969039) passed `sdk-parity` including published Python, real `react-browser` Chromium, and `dependency-audit` with only the existing Zod3 exception. Documentation/journal-inclusive final-head CI still requires verification.
- This is not independently authenticated PNG+JSON provenance, a complete PNG decoder, pixel-level visual similarity, or a new browser run. The historical Windows checkout and untracked `renderer-react/` were untouched; no local npm, Python or Chromium tests were performed. No dependency, lockfile, CI workflow, merger/security configuration, sibling repository or scheduled task changed. The unresolved narrow Zod3 HIGH exception expires 2026-12-07.

## 2026-11-09 — Redacted Markdown summary for browser replay comparisons (PR #51 candidate)

- The existing offline actual-browser comparator produced console status and structured JSON, but no directly reviewable PR-summary artifact. A new opt-in `--markdown` mode renders fixed-schema, bounded Markdown tables of published SDK version pairs and changed indices/counts for actions, browser checkpoints, errors and accessibility findings. It includes pass/health and PNG evidence integrity states while excluding raw action contexts, rendered DOM text, error contents and local paths.
- Output is generated only after the existing strict trace schema and fixture/harness checks and optional paired screenshot integrity verification. `--markdown` and `--json` are mutually exclusive. `--out` writes the chosen format without overwriting prior evidence, and `--strict` retains exit codes 0 for match, 1 for regression/health drift and 2 for invalid evidence. Deterministic Node subprocess tests exercise redaction, matching runs despite a published version bump, an action regression, output fidelity, and overwrite/flag rejection.
- This adds an inspectable reporting format, not a new A2UI defect, new browser fixture, official conformance claim or real customer demand. The original JSON traces remain necessary for deeper audit. Source-head and final-head GitHub Actions must verify SDK/Python parity, actual Chromium and dependency audit before guarded merge; the historical Windows checkout is not used for local tests. Existing Zod3 HIGH advisory exception remains unresolved until 2026-12-07.

## 2026-11-09 — Browser comparison report path-redaction failures

- Source review found that a malformed `--out` target could expose the absolute local path through Node's native `mkdirSync` or `writeFileSync` error text. Successful Markdown exports also echoed that local path on stderr, despite the content-redaction promise.
- The comparator now distinguishes a blocked output directory from a write failure using fixed, path-free messages while retaining the existing non-overwrite `EEXIST` error. Successful export emits a path-free acknowledgement. No screenshots, action contexts or input contents are logged.
- Offline subprocess regressions exercise a directory as the output target (safe existing-path refusal), a greater-than-255-byte output basename (native write error redaction on Linux), an existing file as the output parent (directory setup error redaction), preservation of existing bytes, and redaction on successful Markdown export. The exact final-head GitHub `sdk-parity`, real Chromium `react-browser`, and `dependency-audit` jobs remain authoritative; the original Windows checkout is not used for tests.
- This fixes a local CLI report confidentiality gap, not an A2UI SDK defect or a vulnerability in the published renderer.

## 2026-11-09 — Browser comparison refuses unchanged severe accessibility failures

- A real Chromium replay can contain an accessibility finding even when the baseline and candidate traces are identical. Previously the comparison considered such a candidate healthy whenever `passed` was true and runtime/console error arrays were empty; an unchanged serious issue could therefore yield `MATCH` with `--strict` exit 0.
- The offline comparator now treats `serious`, `error`, `critical`, and `fatal` accessibility severities as blocking candidate health, while informational `info`, `minor`, `moderate`, and `warning` findings remain nonblocking unless other evidence changes. Unsupported or missing severity values fail schema validation without echoing private finding contents. JSON and redacted Markdown expose only the **count** of blocking findings; `--strict` returns exit 1 even if identical traces retain the same severe issue.
- Deterministic Node unit/CLI tests cover the four blocking severities, four nonblocking severities, malformed evidence, an unchanged severe baseline/candidate pair, Markdown/JSON redaction, and strict exit semantics. Published SDK/Python parity and actual React/Chromium runtime remain verified by GitHub Actions, not by this change alone. This identifies a *lab report classification gap*, not a newly established upstream renderer defect or customer impact; the existing TextField missing-accessible-name `warning` is not reclassified as a severe issue.
- No dependencies, lockfiles, workflows, merger/security policy, sibling repositories or local Windows checkout files changed. The unresolved pinned Zod3 HIGH advisory remains under its narrowly scoped exception expiring 2026-12-07.

## E. Browser screenshot/trace publication preflight (2026-11-09)

- The real Chromium replay captures a PNG and records its SHA-256 in the JSON trace. Previously the evidence publisher required a nonempty buffer and a passed report, but it accepted an arbitrary buffer or stale/missing screenshot digest and created the output directory before trying to serialize the report. That could leave misleading or incomplete artifacts, even though the replay was marked passing.
- The publisher now validates the PNG signature, bounded PNG byte length (32 MiB), exact screenshot SHA-256 and `passed: true`, and pre-serializes JSON **before creating the target directory**. A mismatched digest, invalid PNG, missing hash, failed replay or unserializable report cannot create an output directory. Pre-existing output paths are still never overwritten; filesystem write failures after directory creation are outside this preflight guarantee.
- Deterministic offline Node tests exercise rejection without creating artifacts, uppercase hash acceptance and successful publication of actual fixture PNG bytes. This strengthens saved browser evidence integrity, not official conformance, perceptual pixel comparison, authenticated provenance or a new published SDK defect. Actual React/Chromium and Python parity must be proven by target GitHub Actions rather than local Windows tests.
## E. Focused TextField removal and fresh Chromium remount (2026-11-10)

- In the real published React/Core 0.14 Chromium replay, a user first edits and focuses a TextField bound to `/form/label`. A v0.9 `updateComponents` removes only this editor while the surface, Button and shared model remain alive. The harness asserts the prior DOM node detaches, the focus target remains connected, and no synthetic action fires.
- An agent then changes `/form/label` while no input is mounted. Restoring the **same component ID** must mount exactly one fresh TextField showing that new agent value, not the discarded focused draft. Pointer submission after fresh browser editing and keyboard submission after another agent leaf update must emit exact `submit-edited-form` context and preserve sibling model fields.
- Source commit `f63b78ff3c8ac3cc95177688dd01602ad67ec4d0` passed the target GitHub Actions [run 42719135399](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42719135399): real Chromium/React replay, pinned SDK/Python parity and dependency-audit with the documented Zod3 exception. No Windows-local tests or new upstream bug claims. This exercises another integrated browser lifecycle boundary not covered by a schema-only conformance test; Lit/Angular and external developer feedback remain unverified.

## Live Chromium array-indexed TextField/action replay (2026-11-10)

- The existing published React/core **0.14.0** v0.9 Chromium harness now mounts Text, TextField and Button bound to JSON Pointer paths `/items/0/title` and `/items/1/title` in a two-element array.
- One real browser input edit changes item zero while preserving item one and an unrelated falsy root sibling. A pointer action emits both indexed item values. A subsequent agent leaf update at `/items/0/title` updates the mounted input and Text, then a real Enter action emits the fresh item zero value alongside the unchanged item one. The harness checks exact model and action payloads, and requires no unsolicited actions on typing or model updates.
- Source-only GitHub Actions [run 42726408663](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42726408663) passed all three required jobs: `sdk-parity` including pinned published Python, real Chromium `react-browser`, and `dependency-audit` with the existing narrow unresolved Zod3 exception. **The historical Windows checkout was not tested or altered.**
- Scope and limits: one indexed, two-element array and one real React/Chromium renderer using known-installable published packages, not full JSON Pointer compliance, a novel upstream defect, multi-renderer parity, or commercial evidence.

## Real Chromium HTTP/WebSocket origin isolation (2026-11-10)

- The published React/core 0.14.0 Chromium harness already rejected HTTP(S) requests outside its OS-assigned Vite loopback origin. It now registers Playwright 1.56.1 `browserContext.routeWebSocket` before page creation: only `ws:` connections to the **exact** ephemeral Vite origin may call `connectToServer()`; off-origin attempts are closed by the harness without contacting a server.
- A real Chromium `WebSocket` to a different loopback port is a controlled rejection probe. The browser must observe closure and the route must record the exact probe. The final replay verifies that **no additional** off-origin HTTP or WebSocket request was attempted during subsequent render, streaming, TextField, action, accessibility and deletion checks; otherwise it fails before publishing a successful trace.
- The source-head [GitHub Actions run 42734036101](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42734036101) passed `sdk-parity` (including published Python), actual `react-browser` Chromium, and `dependency-audit` on commit `a7133c653104d9f13840408d886ff3ec4ef4d763`. No local tests ran because the original Windows checkout still has historical untracked `renderer-react/` files; source/test changes were remote-only.
- This closes a **test-harness network-isolation gap**, not an upstream A2UI vulnerability, full sandbox for arbitrary executable scripts, all browser networking protocols, or cross-renderer parity. The narrowly allowed pinned Zod3 HIGH advisory remains unresolved until its 2026-12-07 exception deadline.

## Real Chromium stable-ID Button reorder and action isolation (2026-11-10)

- The published A2UI React/core **0.14.0** real Chromium replay now mounts two sibling Buttons under one Column with distinct sourceComponentId and /left versus /right action-context data paths. It first confirms physical DOM vertical order, exact left pointer action and no action from component/model initialization.
- An incremental v0.9 updateComponents changes **only** the parent child order, keeping both Button component IDs and action declarations unchanged. The harness checks that Chromium's measured Button positions swap, neither Button is duplicated or lost, and reordering emits no agent action.
- An agent changes only the /right leaf; the left value and unrelated root sibling remain intact. A real Enter on the reordered right Button must dispatch the updated right value and its own component ID; a later pointer click on the left Button must still dispatch the original left value and its own ID. The complete accumulated action trace must match exactly.
- Source commit [991dd454ee8e8ff6c4ba1021ff1ac558c33306e0](https://github.com/AKzar1el/a2ui-compat-lab/commit/991dd454ee8e8ff6c4ba1021ff1ac558c33306e0) passed [GitHub Actions #42741307389](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42741307389) with sdk-parity (including the published Python SDK), real react-browser Chromium, and dependency-audit with only the preexisting disclosed Zod3 exception. This was GitHub-only: no Windows-local tests or changes to the historical untracked renderer directory.
- Scope: one pair of Basic Catalog Buttons and one published renderer/version. This closes an integration coverage gap, **not** proof of an upstream A2UI defect, full reconciliation correctness, Lit/Angular parity, or external user demand. Pinned Zod3 GHSA-mrhx-c7xc-m3w5 remains unresolved under its temporary exemption expiring 2026-12-07.

## Real Chromium deletion of reordered sibling Buttons (2026-11-10)

- The existing final `deleteSurface` check in the published React/core **0.14.0** browser replay had a vacuous assertion: it waited for `scalarButton` to detach even though an earlier `updateComponents` already replaced that Button with two live reordered sibling Buttons. That assertion could pass without proving that the **currently mounted** buttons were removed.
- [PR #59](https://github.com/AKzar1el/a2ui-compat-lab/pull/59) source commit [58ea6d756f80cdc8f5e650d19bfbc424032adc52](https://github.com/AKzar1el/a2ui-compat-lab/commit/58ea6d756f80cdc8f5e650d19bfbc424032adc52) retains handles for both visible sibling DOM nodes before deletion, requires each to detach, checks there are **zero** remaining browser Buttons and verifies both captured elements have `isConnected === false`. The existing Enter-key/no-late-agent-action assertion remains, and the deletion checkpoint now reports the count of actually mounted Buttons rather than the old locator.
- Source-head [PR GitHub Actions #42754504965](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42754504965) passed `sdk-parity` (including pinned published Python), actual `react-browser` Chromium regression, and `dependency-audit` under the existing narrow Zod3 advisory exception. **No Windows-local tests were executed**; the historical checkout and untracked `renderer-react/` remained untouched.
- This fixes **coverage of actual renderer deletion behavior** rather than claiming a new upstream SDK defect, broader cross-renderer parity, or customer/revenue evidence. The pinned Zod3 HIGH GHSA-mrhx-c7xc-m3w5 is still unresolved and its narrow exception ends **2026-12-07**.

## Real Chromium structural array reorder and live action rebinding (2026-11-10)

- The existing published React/core **0.14.0** v0.9 browser replay already exercised an editable TextField bound to `/items/0/title`, with Button contexts referencing indices zero and one. It did **not** check how those existing mounted bindings behaved when an agent replaced the entire `/items` array, potentially moving values between indices.
- [PR #60](https://github.com/AKzar1el/a2ui-compat-lab/pull/60) adds a deterministic actual Chromium step that replaces `/items` with reversed values **while keeping the same TextField mounted**. The harness requires the visible Text and input to show the new item at index zero, the original input DOM node to remain connected, both model items and unrelated root fields to be preserved, and no synthetic action on model replacement.
- The same existing Button must then dispatch a real pointer event and Enter-key event whose exact contexts reflect the new ordering of **both** indices, never stale pre-reorder values. Source-head [PR CI #42761195723](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42761195723) passed `sdk-parity` with published pinned Python, real `react-browser` Chromium, and `dependency-audit` with the previously documented Zod3 exception.
- Scope: one published React/core v0.9 integration and one two-item array; this closes a specific browser/replay coverage gap, **not** proof of an upstream defect, complete JSON Pointer array semantics, Lit/Angular parity or commercial demand. Historical Windows checkout and untracked `renderer-react/` were not modified or locally tested. Pinned Zod3 GHSA-mrhx-c7xc-m3w5 remains unresolved under its narrow exception ending **2026-12-07**.

## Real-browser evidence publisher path-redaction regression (2026-11-10)

- The standalone browser-trace comparator already redacted path-bearing native output errors, but the *real Chromium evidence publisher* still included the absolute output directory in its existing-path failure. An unexpected lstatSync, parent mkdirSync, exclusive directory creation or PNG/JSON write failure could also propagate native errors containing private filesystem paths.
- The publisher now issues fixed, path-free failure diagnostics for each filesystem operation while retaining exclusive directory and wx artifact creation. It still refuses to overwrite pre-existing evidence and preflights a passing report, PNG signature/digest and JSON serialization before any artifact directory is created. Filesystem failures *after* creation may leave partial artifacts for inspection, but never report publication success.
- The offline Node regression exercises the existing-directory collision and an actual native ENOTDIR lookup through a parent regular file; it asserts no private path segment appears in diagnostics and original user bytes remain intact. The existing test suite continues to cover successful PNG/JSON publication, no-overwrite, invalid evidence and serialization.
- [PR #61](https://github.com/AKzar1el/a2ui-compat-lab/pull/61) uses remote GitHub-only edits because the historical Windows checkout has untracked renderer artifacts; local Node/Python/Chromium tests were not run. Its final-head sdk-parity, react-browser, and dependency-audit GitHub CI must pass before any exact-SHA merger handoff. This addresses a **lab artifact diagnostic confidentiality gap**, not a newly established defect in upstream A2UI SDKs or evidence of user demand. Zod3 GHSA-mrhx-c7xc-m3w5 remains unresolved under the existing narrow exception through 2026-12-07.

## Browser replay action-route evidence integrity (2026-11-10)

- Source-level review showed that the **lab's own** real-browser trace comparator accepted an apparently passing trace with no replay checkpoints, or actions containing only a name and no originating surface/component or event context. Identical malformed evidence could be reported as a healthy match, despite missing proof of an exercised replay. This is an evidence-schema validation gap, **not** an observed upstream A2UI SDK defect.
- [PR #62](https://github.com/AKzar1el/a2ui-compat-lab/pull/62) requires at least one replay checkpoint and nonempty `surfaceId`, `sourceComponentId`, and object-valued `context` for every observed action. A legitimate rendering-only trace may still contain zero actions. New deterministic offline test cases reject missing/empty route fields, invalid context shapes, and zero-checkpoint reports with path-free, content-free schema errors.
- Source-and-test-head [GitHub Actions #42774534080](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42774534080) passed `sdk-parity` with actual published Python, `react-browser` using actual Chromium and the pinned published React/core packages, and `dependency-audit` with the existing narrowly disclosed unresolved Zod3 HIGH exception. The final documentation/journal-inclusive PR head requires independent CI verification before handoff.
- Scope: stricter local comparison of *reported* browser evidence, not cryptographic attestation, complete A2UI renderer conformance, proof of an upstream bug, or customer demand. No Windows-local Node/Python/Chromium tests or checkout writes were performed because historical untracked `renderer-react/` artifacts must remain untouched. The temporary Zod3 GHSA-mrhx-c7xc-m3w5 exception expires **2026-12-07**.

## Real Chromium live Button event-property rebind (2026-11-10)

- Source-head [CI #42781539793](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42781539793) exercised the published React/core 0.14 pair in actual Chromium. All three required jobs passed, including real Python SDK parity and the existing narrowly disclosed Zod3 dependency-audit exception.
- With two mounted sibling Buttons, a v0.9 `updateComponents` message replaces one Button's event name and action-context model paths **without changing its component ID**. Playwright pointer input emitted the new event with the newly mapped values; subsequent agent model change plus real keyboard Enter emitted the new event with fresh values. The untouched sibling still dispatched its original action against updated data.
- The trace checks that neither agent update emits a synthetic action and that both Buttons remain mounted. This confirms a specific integrated renderer lifecycle contract on the pinned published pair; it is **not** evidence of an upstream bug, a cross-renderer guarantee or paid customer demand. Historical Windows checkout was not modified or used for tests.

## Real Chromium focus-preserving live Button action update (2026-11-10)

- [PR #64](https://github.com/AKzar1el/a2ui-compat-lab/pull/64) extends the real published React/core **0.14.0** Chromium replay beyond the earlier same-ID action hot-swap: it focuses the live right sibling Button and retains its real DOM handle before an agent replaces **only** that Button's action name/context. The updated component must keep the same connected DOM node and active browser focus; the agent update must not emit an action.
- Actual Chromium **Space without an explicit refocus** must route to the new `choose-right-focused` event with current `/right` and `/left` model values and the original `pick-right` source component ID. The existing sibling-action and final surface-delete assertions remain intact; action traces must match exactly.
- Source commit `16e02c086c86fad5b80fa78fab609c0fd83a3174` passed [GitHub Actions #42789620328](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42789620328): `sdk-parity` including published Python, real `react-browser` Chromium (**41 checkpoints / 49 agent events / zero runtime errors**) and `dependency-audit` with the existing narrow unresolved Zod3 HIGH exception. No Windows-local npm/Python/browser tests were run; the old checkout and untracked `renderer-react/dist/` remain untouched.
- This is one integrated renderer keyboard/focus regression on a pinned published release pair, **not** proof of an upstream A2UI defect, other renderers, complete accessibility conformance, external users or paid demand. The Zod3 GHSA-mrhx-c7xc-m3w5 exception expires **2026-12-07**.

## Native held-Space release across a live Button action update (2026-11-10)

- The published React/core 0.14 real-Chromium suite already tested an A2UI Button action replacement **before** the next Space press. It did not exercise an in-flight native keyboard activation when the agent changes that focused Button's event between Space **keydown** and **keyup**.
- [PR #65](https://github.com/AKzar1el/a2ui-compat-lab/pull/65) keeps the physical `pick-right` Button mounted and focused; Playwright holds Space down, applies a same-ID `updateComponents` event rebind, and then releases Space. The test requires no early keydown action or synthetic agent-update click; exactly one release action must use the replacement event `choose-right-on-release` with the current independent `/right` and `/left` values.
- Source SHA `31cff9384b3d0c6d9679c7115733ec70e81d88d0` passed [CI #42797531292](https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42797531292): `sdk-parity` including published Python, actual `react-browser` Playwright Chromium, and `dependency-audit` with only the previously disclosed narrow Zod3 HIGH exception. No local Windows npm, scan, Python or Chromium tests were run; the original untracked renderer artifacts remain untouched.
- This is deterministic coverage of an integrated native keyboard/action lifecycle boundary on the pinned published package pair, **not** proof of an upstream bug, general IME or accessibility conformance, Lit/Angular behavior, or commercial interest. The Zod3 GHSA-mrhx-c7xc-m3w5 remains unresolved under a narrow exception expiring 2026-12-07.
