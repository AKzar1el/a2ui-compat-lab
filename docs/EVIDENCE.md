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
- **No paying users, commercial demand, actual visual regression output, or complete browser replay has been validated.** Do not state otherwise.
- A2UI specification version labels are changing; pin exact package versions and surface protocol version in every report.

## D. Honest acceptance gates for pilot

1. CI runs clean with a real SDK, stable baseline and reference validator.
2. Optional real Python comparison runs and aligns on all 25 inputs.
3. Release matrix reproduces 0.14 vs 0.15 strict install difference.
4. Next: one deterministic full surface lifecycle/action replay using actual renderer APIs, with a failure official upstream tests do not exercise.
5. Next: find at least one external developer or integration team for usability feedback.

## First headless lifecycle replay
The project also exercises the actual published A2UI v0.9 MessageProcessor with a five-event lifecycle (create surface, add components, initialize data, update data, delete surface). JSONL boundary fuzzing at 1/7/57 characters produces identical snapshots; malformed/incomplete lines fail closed. Run `npm run replay:demo` for a JSON trace in `out/replay.json`. This is not a browser or screenshot test.
