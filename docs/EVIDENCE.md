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
