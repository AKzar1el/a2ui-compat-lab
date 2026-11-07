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

## 2026-11-07 — Second scheduled wake: correct checkout and P0 release diagnostics
- The existing shared God v5 selected the correct `a2ui-compat-lab` source checkout with `createWorktree:false`; confirmed clean `main` at `a851a8608daa3520bc6577d16f62de0942969640` matching `origin/main`, and the correct GitHub remote. No open A2UI PRs or unfinished local changes before starting.
- Feature branch: `revshot/a2ui-release-probe-failclosed-20261107`. Initial implementation commit: `ef62a3208c332779dbd5aa8fbb4f33e10e7f63be`. PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/4.
- Scoped changes: release probe identifies authoritative npm ERESOLVE versus registry/network failures, timeout, interruption and unrelated npm errors; JSON reports include structured failure kind, npm error code and a recommended next action. Added four deterministic classifier tests, CLI diagnostics, README and dated evidence. Local worker instructions aligned to task prompt v1.1 without modifying the scheduler or siblings.
- Validation: Node 22.22.2/npm 10.9.7 on Windows; `npm test` **14/14 PASS**; `npm run scan:check` **25 fixtures, 9 expected discrepancies, baseline MATCH**; `git diff --check` clean. One bounded external npm resolution probe (45s per pair): React/web_core 0.14 resolves; 0.15 fails with confirmed `npm error code ERESOLVE` from the `@a2ui/markdown-it@0.2.2` peer constraint.
- Optional local Python parity was attempted after generating `out/differential.json`, but this shell's default Python lacks the `a2ui` module (`ModuleNotFoundError`). The GitHub CI job installs `a2ui-core==0.5.0` separately, and must provide the authoritative cross-language check. Do not claim local Python parity succeeded.
- Next: verify PR #4 GitHub checks and hand off to the existing merger without self-merging; continue the remaining P0 matrix acceptance and then P1 real renderer/action replay. No unrelated fleet changes.

## 2026-11-07 — Third scheduled wake: SDK parity upgrade comparison
- Workspace: verified the correct `a2ui-compat-lab` ordinary source checkout, correct `origin`, and clean previous PR branch; no sibling work touched. Prior PR #4 is independently complete/open and waiting for merger. Fetched `origin/main` at `a851a8608daa3520bc6577d16f62de0942969640` and created branch `revshot/a2ui-parity-drift-report-20261107` from that baseline.
- Scope: introduced an offline CLI `compare` for saved scan reports with resolved/new/persistent discrepancies, direction flips, SDK/reference decision changes, changed reference configuration, and fixture-set drift. Invalid inputs fail closed; strict mode requires review on any observed drift. No fixture/baseline mutation. Strict scan also checks the real installed `@a2ui/web_core` version instead of borrowing the version from the baseline.
- Source commit `5e5e893d7d4e28fa7cbe9f8553ff101bb9beb456`; PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/5 (not self-merged).
- Local Windows Node 22 verification: `npm test` **16/16 PASS**; `npm run scan:check` **25 cases / 9 expected discrepancies, MATCH**; local real pinned scan compared against itself **25 matching fixture decisions, 9 persistent discrepancies, no drift**; `git diff --check` clean. Synthetic drift tests do not claim new real upstream regressions. Local Python parity not rerun; GitHub CI remains the authoritative check. No external npm probe or browser renderer testing on this wake.
- Next: verify the exact final PR head in GitHub Actions and hand off to the existing merger. PR #4 also changes this append-only log; integration should preserve both chronological entries. Continue P1 #2 with a real pinned React renderer/action replay when safe. No automation, Codexify configuration, or sibling repository was changed.
