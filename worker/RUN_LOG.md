# A2UI Compatibility Lab — worker receipts

## 2026-11-07 — Owner-approved bootstrap
- Origin: confirmed signed-agent alternative failed commercial differentiation; this second pilot identified real A2UI TS/Python validator drift and npm package-release incompatibility.
- Repo created as a separate `a2ui-compat-lab` checkout. First commit and CI status must be recorded here after verification.
- Initial tests: see `docs/EVIDENCE.md`; do not represent unexecuted browser/replay tests as complete.
- Next work: address highest-priority P0 item and only then begin P1 replay with real renderer.

## 2026-11-07 — Bootstrap closeout (verified)
- Canonical checkout: C:\Users\Tomi\Desktop\lol\a2ui-compat-lab (ordinary source checkout, no worktree).
- Initial commit: 86b5217b45ad8725e62c84f72d27d509477ba207, pushed to https://github.com/AKzar1el/a2ui-compat-lab (main).
- GitHub Actions: first run #42322050783 passed: https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42322050783.
- Gates: clean npm ci; Node 10/10 passing; 25 actual SDK fixtures with 9 pinned TS/Python disagreements; real Python A2UI Core 0.5.0 parity passed; release probes: 0.14 pair resolves, 0.15 pair gives expected ERESOLVE; headless real v0.9 MessageProcessor JSONL trace passed.
- Ready backlog: #1 release matrix robustness, #2 real browser interaction/recovery replay, #3 version-aware parity reports.
- Hourly scheduled worker created for minute :10 Europe/Ljubljana. Scheduler confirmed enabled; workspace binding must be inspected on first wake because originating conversation is bound to mcp-trendpulse. If wrong, require the Codexify setup card's explicit Switch to another project control. Never operate on the wrong project.
- Commercial status: pilot only; no revenue/customer validation; no browser-rendered UI replay yet.
## 2026-11-07 — First scheduled wake: fail-closed workspace guard
- Actual first task run completed early with the WRONG Codexify workspace: mcp-trendpulse, not a2ui-compat-lab.
- Worker correctly performed no project operations and paused the new A2UI automation. Existing fleet and source files remained untouched.
- Unblock manually in the A2UI scheduled run's Codexify setup card: choose 'Switch to another project', select C:\Users\Tomi\Desktop\lol\a2ui-compat-lab, ordinary source checkout, createWorktree:false.
- After an explicit correct selection and read-only git/remote verification, re-enable the SAME scheduled task. Do not create a duplicate task or a second tunnel.
- New A2UI task remains PAUSED until that user selection; do not describe it as running hourly yet.

## 2026-11-07 — Fifth scheduled wake: real React Chromium pointer and keyboard replay
- Correct source checkout `C:\Users\Tomi\Desktop\lol\a2ui-compat-lab` and exact `AKzar1el/a2ui-compat-lab` remote verified. Local tree clean before work; canonical `origin/main` a851a8608daa3520bc6577d16f62de0942969640. PRs #4, #5, and #6 remain separately open for the existing merger; no changes to them.
- Branch `revshot/a2ui-react-dom-replay-20261107` based on `origin/main`. Source commit `60982b3348948f1746a2ccc2ba59737777748916`. PR https://github.com/AKzar1el/a2ui-compat-lab/pull/7. Adds isolated strictly resolving `@a2ui/react@0.14.0` + `@a2ui/web_core@0.14.0` with React 19.2.0, local Vite 7.1.12 and Playwright Chromium 1.56.1; root A2UI core 0.15 differential harness unchanged.
- Real browser integration uses published `A2uiSurface`, Basic Catalog custom elements, a deterministic v0.9 fixture and genuine Chromium pointer/keyboard input. Pointer click emits action context `selection=alpha`; agent data update changes visible text to `beta`; keyboard Enter emits context `selection=beta`; deleting the surface removes the Button and prevents another action. Four logged checkpoints, two actions, zero page/surface errors. Local inspectable JSON trace and screenshot are produced under ignored `renderer-react/out/`. Added a separate GitHub Actions browser job with artifact upload.
- Locally verified `npm test` 10/10, `npm run scan:check` 25 cases/9 expected discrepancies MATCH, isolated strict `npm ci`, `npm test --prefix renderer-react` PASS, `npm run build --prefix renderer-react` PASS (non-blocking large bundle warning), and `git diff --check`. Local Python parity and optional external release probe were not rerun; the existing Python CI gate remains.
- Limitations: narrow React v0.14/Chromium/Button proof, not a newly discovered upstream bug, not 0.15 React support, not complete recovery/accessibility/pixel-diff or cross-renderer comparison; no customer or revenue claims. Exact final-head CI result must be checked before describing PR as green. Handoff to existing merger only; preserve concurrent append-only log receipts from PRs #4/#5/#6, and do not self-merge. No other repositories, automations, Codexify configuration or fleet worker schedules changed.
