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

## 2026-11-07 — Fourth scheduled wake: real core SDK Button action replay
- Workspace verified: ordinary `C:\Users\Tomi\Desktop\lol\a2ui-compat-lab` checkout, correct `AKzar1el/a2ui-compat-lab` origin, clean previous PR #5 branch. `origin/main` was `a851a8608daa3520bc6577d16f62de0942969640`. Existing PRs #4 and #5 are open and ready for the merger, no rework attempted.
- Branch: `revshot/a2ui-action-replay-20261107`, starting from clean `origin/main`. Code commit: `0dd62e257deeb2127c40a7d72ef7110389558bf2`. PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/6.
- Implemented a **headless**, deterministic v0.9 action replay using real `MessageProcessor`, `ComponentContext`, and `GenericBinder`: create Button surface, emit two events with changing data context, apply simulated agent response, delete surface. Added JSONL chunk-boundary parity, wrong-component/deleted-target refusal, an inspectable `out/action-replay.json` report and README/evidence notes. Source files: `src/replay.mjs`, `src/replay-action-report.mjs`, `fixtures/action-v09.json`, `test/replay-actions.test.mjs`, `package.json`, `README.md`, `docs/EVIDENCE.md`.
- Local verification on Windows Node 22: `npm test` 14/14 passed, `npm run scan:check` 25 fixtures/9 known discrepancies matches baseline, `npm run replay:actions` 7 states/2 actions/all four chunk trials matched, `git diff --check` passed. Python parity and external npm release probe not rerun locally; Python gate remains in GitHub CI.
- This **does not** fulfill browser/React pointer or keyboard acceptance and claims no new upstream issue. Continue issue #2 with real DOM interaction and fault/recovery evidence; leave PR #6 to existing merger after its final commit CI checks. Preserve #4/#5 and this receipt during any conflict resolution. No other checkout, scheduler, tunnel, or fleet configuration changed.
