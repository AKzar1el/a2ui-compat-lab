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

## 2026-11-07 — UTF-8 transport byte replay (scheduled run)
- Verified selected project C:\Users\Tomi\Desktop\lol\a2ui-compat-lab, ordinary checkout, origin AKzar1el/a2ui-compat-lab, baseline origin/main a851a86; source branch revshot/a2ui-utf8-stream-replay-20261107. No concurrent writer or unrelated tracked changes observed.
- Existing PRs #4–#9 remained OPEN/non-draft and green at inventory; their branches and receipts were not changed. Preserved the pre-existing untracked renderer-react/ directory without staging it.
- Source commit 2999bbcf4f72983690d9d090354e93d68c1c507a: strict bounded Uint8Array/Buffer JSONL parser, Unicode real-SDK byte chunk replay and CI JSON artifact, regression tests, README/EVIDENCE.
- Local offline gates: npm test 12/12 PASS; npm run scan:check 25 fixtures/9 expected discrepancies MATCH; npm run replay:demo six byte sizes (1/2/3/7/57/648) all match headless published-SDK snapshots; git diff --check clean. Python parity is GitHub CI's responsibility for this run; no network-dependent release probe.
- PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/10, review/integration assigned to existing fleet merger (never self-merge). Final-head GitHub Actions and artifact must be checked after receipt commit.
- Novelty boundary: this tests a previously unsupported transport type in OUR harness; it is not proof of a new upstream A2UI defect or browser-rendering failure. Next candidate: React browser failure/recovery and merged PR integration, after unfinished-first inventory. Do not modify schedules or sibling repos.
