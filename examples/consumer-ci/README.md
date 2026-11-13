# Real Chromium CI starter for an A2UI consumer

This is a **copyable integration recipe**, not a hosted service or official
A2UI conformance certificate. It uses the pinned published React/core 0.14
renderer to replay developer-owned v0.9 JSONL captures. It is designed to fail CI on changed observed error boundaries, on *either*
replay showing an observed failure, **or on changed visible Text** even when
both captures replay without errors. The two checks now share **one pair of Chromium replays**, using transient keyed
Text comparisons. Neither check activates Buttons.

## Verify the local demo first

From the repository root, install the isolated renderer dependencies and
Chromium once (no API keys or inference services):

```sh
cd renderer-react
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
cd ..
```

The committed before capture is `fixtures/lifecycle-v09.jsonl`. The public,
synthetic candidate at `examples/consumer-ci/after.jsonl` changes a Text
value at event index 2, without changing the structure. The **rendered-text**
comparison should detect this real React/Chromium UI drift:

```sh
node src/browser-capture-summary-compare.mjs --before-capture fixtures/lifecycle-v09.jsonl --after-capture examples/consumer-ci/after.jsonl --compare-rendered-text --strict --out out/consumer-text-demo.json
```

Expected result: exit **1** with `renderedTextParity: "drift"` and
`firstDifferentRenderedTextEventIndex: 2`. This nonzero exit is an
intentional regression demonstration, not proof of a renderer defect.
Use a fresh output path for subsequent runs: the tool refuses overwrite.

For a **combined one-pair replay-health and rendered-Text CI gate**, generate
JSON, Markdown and JUnit in one new directory:

```sh
node src/browser-capture-error-boundary-compare.mjs --before-capture fixtures/lifecycle-v09.jsonl --after-capture examples/consumer-ci/after.jsonl --require-no-observed-failures --compare-rendered-text --strict --report-dir out/consumer-one-pair-demo
```

Expected result: exit **1** because Text drift is observed at event 2, although
both replays have **no observed failures**. The combined `comparison.json`
includes `observedFailuresAbsent: true`, `renderedTextParity: "drift"`, and
`firstDifferentRenderedTextEventIndex: 2`. The combined JUnit file
`comparison.xml` fails its rendered-Text assertion without a second Chromium
pair. If either replay fails, Text parity is reported as **unavailable**, not
misleadingly marked matching; strict failure policy remains enforced.
A malformed capture or output collision exits **2**. An existing report
directory is never overwritten. Transient HMACs stay inside the comparator
and its child processes and are not saved with reports.

Both scenarios run in the existing `react-browser` CI job using the published
renderer, not a mocked DOM or unverified example command.

## Adapt the GitHub Actions recipe

The template is [`workflow.yml`](workflow.yml). Copy it into **your**
repository under `.github/workflows/a2ui-compare.yml` and review its
contents. It is deliberately **manual** (`workflow_dispatch`) until you
supply trusted capture generation. Replace `ci/a2ui-before.jsonl` and
`ci/a2ui-after.jsonl` with paths produced by your application's own
capture step. The example does not invent capture tooling and will fail
closed when those files are missing.

The workflow checks out the lab at an **immutable source commit**, installs
the isolated published React/core dependencies, then uses a single
`--require-no-observed-failures --compare-rendered-text --strict --report-dir`
comparison. Either observed replay failures or rendered-Text drift fail CI.
It creates three combined reports with **one** Chromium pair; there is no
second rendered-Text JUnit file. Other UI properties (such as Button
focus/geometry) are not covered by this starter.

By default, the workflow **does not** upload artifacts or add a GitHub step
summary. The generated JSON, Markdown and combined JUnit reports live only in the
runner's temporary directory. After you inspect your capture metadata and
decide publication is acceptable, explicitly set the repository Actions
variable `A2UI_SHARE_COMPARISON_METADATA=true` to enable a one-day
artifact and step summary. The optional artifact also includes the Text
parity assertion inside the combined JUnit report; the step summary shows
the combined health and Text Markdown.
Never upload the raw JSONL captures.

Privacy-reduced is **not anonymous**: event counts, failure indices and
parity decisions can disclose workflow structure. Keep capture generation
private, review consumer permissions, and never expose raw model values,
identifiers, paths or secret-bearing action payloads. The example never
activates Buttons. The GitHub-hosted runner uses normal Actions minute
allowances, which can be metered for private repositories; check the
repository's free quota before enabling runs. No paid API or SaaS is needed.

The demo proves a runnable developer workflow, not third-party usage,
security clearance, user adoption or commercial revenue.
