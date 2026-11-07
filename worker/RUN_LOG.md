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

## 2026-11-07 — Seventh scheduled wake: published SDK rejection/recovery trace
- Verified ordinary A2UI source checkout, exact GitHub remote, clean tracked state and fresh `origin/main` `a851a8608daa3520bc6577d16f62de0942969640`. Existing PRs #4-#8 remained open, mergeable and green; none modified or self-merged. Pre-existing untracked `renderer-react/` preserved untouched.
- Branch `revshot/a2ui-fault-recovery-20261107` from `origin/main`; source commit `99f1dd32eb1ac3b75bf80e80085c35bc872f754d`; PR https://github.com/AKzar1el/a2ui-compat-lab/pull/9.
- Added a real published `@a2ui/web_core@0.15.0` v0.9 `MessageProcessor` fault/recovery trace, a two-surface fixture, deterministic regression tests and an offline JSON artifact gate in GitHub Actions. Tests demonstrate rejection of missing/late surfaces and an unknown catalog while subsequent healthy updates and surface recreation succeed. Rejected messages did not mutate **observed** surfaces or emit actions; harness stops if observable state changes on rejection.
- Local verification: `npm test` 15/15 passed; `npm run scan:check` 25 fixtures / 9 pinned discrepancies MATCH; `npm run replay:recovery` 13 events (10 applied, 3 rejected) and four identical JSONL chunk trials; `git diff --check` passed. No local Python parity or network release probe was run; GitHub CI performs the Python gate.
- Scope remains headless SDK error containment, not browser error recovery, hidden SDK state verification or a novel upstream bug claim. Existing fleet merger should verify final PR-head CI and preserve append-only receipts from all concurrent PRs. Next candidate: browser-level React failure injection, then multi-renderer comparisons once PR #7 integrates.
