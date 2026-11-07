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

## 2026-11-07 — Sixth scheduled wake: offline installation doctor
- Verified correct ordinary source checkout `C:\Users\Tomi\Desktop\lol\a2ui-compat-lab` and exact `AKzar1el/a2ui-compat-lab` remote. Canonical `origin/main` was `a851a8608daa3520bc6577d16f62de0942969640`. PRs #4/#5/#6/#7 were separately open, mergeable, and all reported checks green; no self-merge or changes to those PRs.
- Branch `revshot/a2ui-offline-doctor-20261107` from verified `origin/main`; feature commit `70cff07da3887cd99e189f98c31d54c4c6376269`; PR https://github.com/AKzar1el/a2ui-compat-lab/pull/8. Owned changed files: `src/doctor.mjs`, `src/cli.mjs`, `test/doctor.test.mjs`, `test/cli.test.mjs`, `package.json`, `README.md`, plus this append-only receipt.
- Offline `doctor` checks required Node version, exact direct dependency pin, root lockfile and installed package versions; `--version` works independently of SDK module loading. Missing, malformed, drifted and path-invalid states covered by isolated deterministic tests.
- Local verification: `npm run doctor` READY (Node 22.22.2, web_core 0.15.0, Ajv 8.17.1); `npm test` 19/19 passed; `npm run scan:check` 25 fixtures/9 expected differences MATCH; `git diff --check` passed. No external npm release probe or local Python SDK parity executed in this wake; GitHub CI has that gate.
- Untracked `renderer-react/` from the previous feature branch was preserved untouched when switching to `origin/main`; explicitly staged only owned files. Scope is direct dependency readiness, not transitive provenance, browser testing or novel upstream findings.
- Handoff: verify exact final-head GitHub Actions for PR #8, then existing merger may review/integrate after normal gates while preserving run-log entries from other open PR branches. Next useful work: P1 renderer failure/recovery or cross-renderer comparisons, after inventorying unfinished PRs. No sibling repository, automation, Codexify setup or shared service changed.
