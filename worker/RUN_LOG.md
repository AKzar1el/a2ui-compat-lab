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

## 2026-11-07 — Local JSONL session replay, independently testable
- Verified correct ordinary source checkout and AKzar1el/a2ui-compat-lab remote, fresh origin/main baseline `a851a86`; previous PR #11 branch had no owned uncommitted changes. All PRs #4–#11 were OPEN/MERGEABLE with green checks at inventory; no change made to them.
- Feature branch `revshot/a2ui-user-jsonl-replay-20261107`; source commit `baa5035130cb83a0b889f514bcbe1d33e3e98863`. Files: `src/replay-file.mjs`, `test/replay-file.test.mjs`, `fixtures/lifecycle-v09.jsonl`, README, docs/EVIDENCE.md and .github/workflows/ci.yml.
- Added an offline, bounded, explicit local JSONL capture replay that produces deterministic lifecycle snapshots using the actual pinned `@a2ui/web_core@0.15.0`; rejects malformed UTF-8, incomplete JSONL, excess input/frames and existing report paths. CI now exports a sample replay JSON artifact. This is NOT a browser renderer test or upstream vulnerability claim.
- Windows local gates: `npm test` 17/17 PASS, `npm run scan:check` 25 SDK fixtures/9 expected deviations MATCH, bundled JSONL 5-event replay PASS, `git diff --check` PASS. Python parity not installed/attempted locally; GitHub Actions is the Python verification gate. No external release probe.
- PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/12 (non-draft, mergeable on creation). Exact-head CI and merger handoff to be verified after this log receipt commit.
- The pre-existing untracked `renderer-react/` was preserved. No change to other repos, jobs, Codexify configuration, or the merger. Next: integrate compatible PR backlog #4–#12, then add real browser-level failure/recovery and cross-renderer tests.
