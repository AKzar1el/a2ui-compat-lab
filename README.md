# A2UI Compatibility Lab

**Local-first, reproducible compatibility testing for the A2UI ecosystem.** This is an experimental developer tool, not an official A2UI conformance certification program.

[![A2UI Compatibility CI](https://github.com/AKzar1el/a2ui-compat-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/AKzar1el/a2ui-compat-lab/actions/workflows/ci.yml)

## What it tests

**1. Actual published SDK behavior:** Run 25 controlled JSON Schema Draft 2020-12 fixtures against `@a2ui/web_core@0.15.0` and Ajv. The observed pinned baseline contains **9 TypeScript validation discrepancies**: 3 in [upstream issue #3998](https://github.com/a2ui-project/a2ui/issues/3998) and 6 additional cases. The expectation baseline records *observed defects*, not desirable behavior. A future upstream fix should be reported as a baseline change, not silently discarded.

**2. Cross-language behavior:** An optional Python runner compares the same fixtures against the real `a2ui-core==0.5.0` package. No LLM, paid API, database or browser session is required.

**3. Published release compatibility:** A clean npm project is generated in OS temp for each pinned React + web_core combination. Using `npm install --package-lock-only --strict-peer-deps --ignore-scripts`, the previous 0.14.0 pair resolves; the 0.15.0 pair currently fails `ERESOLVE` because `@a2ui/markdown-it@0.2.2` requires `web_core ^0.14.0`. A rejected install is reported as a compatibility finding, not hidden as a green install.

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

`doctor` is a fast, read-only, offline installation preflight. It checks the declared Node.js minimum, exact direct dependency pins, package-lock entries and the actual installed package versions. Use `doctor --json --strict --out out/doctor.json` for a machine-readable report (exit 1 on mismatch; exit 2 on invalid invocation). It checks *this workspace's direct packages*, not the npm registry, transitive dependency provenance, React's isolated renderer workspace or remote published-release compatibility. Run `npm ci --ignore-scripts --no-audit --no-fund` to repair a missing or stale installation before retrying.

## Non-goals and scope

This first milestone **does not** implement actual browser-based A2UI event replay, prove a business model, certify conformance, or claim that the six additional cases are unknown to all other A2UI contributors. See [Evidence](docs/EVIDENCE.md) and [Roadmap](docs/ROADMAP.md).

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
