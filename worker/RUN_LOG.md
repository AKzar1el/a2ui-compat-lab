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

## 2026-11-07 — Node 24-compatible CI action runners (PR #13)
- Verified exact source checkout and origin `AKzar1el/a2ui-compat-lab`, clean owned files on entry (pre-existing untracked `renderer-react/` preserved), and current `origin/main` `a851a8608daa3520bc6577d16f62de0942969640`. PRs #4–#12 remained open, mergeable and green; no active local writer was detected by a bounded process check.
- Branch `revshot/a2ui-node24-actions-20261107`, code SHA `c7cb6527de5037d3c33a284db95712d167e730a6`, changed `.github/workflows/ci.yml` only: Node 24-capable checkout/setup-node/setup-python/upload-artifact v7 actions, least-privilege checkout credentials off, existing test runtimes Node 22 and Python 3.13 unchanged.
- Local Windows gates: `npm test` 10/10 PASS, `npm run scan:check` 25 fixtures / 9 expected mismatches MATCH, `git diff --check` PASS. Python parity not run locally; leave it to CI. No network-dependent npm release probe run.
- PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/13, open for existing merger, not self-merged. Exact-head GitHub Actions and artifact verification to be reported after this receipt commit. No other worker, repository, schedule, or Codexify service edited.
- Next work: finish PR #13 CI/handoff; integrate pending PRs with append-only log reconciliation. Then React browser failure-recovery tests after #7 reaches main.
