# Real Chromium CI starter for an A2UI consumer

This is a **copyable integration recipe**, not a hosted service or official
A2UI conformance certificate. It uses the pinned published React/core 0.14
renderer to replay developer-owned v0.9 JSONL captures. It is designed to fail CI on changed observed error boundaries, on *either*
replay showing an observed failure, **or on changed visible Text, Button geometry or keyboard Tab reachability** even when
both captures replay without errors. The replay-health, rendered-Text, Button-geometry and Tab-focus checks share **one pair of Chromium replays**, using transient keyed comparisons. No check activates Buttons.

## Check your consumer SDK lane before copying this workflow

The browser starter validates the **published React/core 0.14.0 pair and
v0.9 captures only**. An external A2UI v1.0 consumer, for example the public
[Kaltura A2UI catalog](https://github.com/kaltura/kaltura-a2ui-components/blob/main/package.json)
which declares `@a2ui/react@^0.15.0` and `@a2ui/web_core@^0.15.0`,
is **outside this tested lane**. A green test here does not validate
Kaltura or any other 0.15 renderer.

Use the offline, no-install manifest preflight from a fresh lab checkout
before adapting the copied workflow:

```sh
node src/consumer-version-preflight.mjs --manifest /path/to/your/package.json --protocol v0.9
```

For npm applications with a root `package-lock.json` (v2/v3), opt into the
stronger **offline lockfile metadata cross-check**:

```sh
node src/consumer-version-preflight.mjs --manifest /path/to/your/package.json --lockfile /path/to/your/package-lock.json --protocol v0.9
```

With `--lockfile`, exit 0 additionally requires the root lockfile's A2UI
declarations to match the manifest and its direct
`node_modules/@a2ui/react` and `node_modules/@a2ui/web_core` records to
both say version `0.14.0` (not symlinked). A stale lockfile, missing direct
package record, unsupported npm lockfile v1, or workspace-only lockfile
fails closed with exit 1. Malformed/oversized lockfile input fails with
exit 2. Package names, paths, resolution URLs and private manifest values
never appear in the fixed-label report; the input lockfile is not uploaded.
This check is for the **root npm application**, not an arbitrary monorepo
subworkspace. It checks metadata, not actual installed files, npm peer
resolution, browser-loaded code or capture contents. It makes no new
claims about 0.15/v1.0 compatibility.

Give the *real target application's* manifest and the **actual** capture
protocol, not a guessed v0.9 value to make CI pass. Without `--lockfile`, this tool checks
manifest declarations only: 0 means both SDKs are explicitly pinned to
0.14.0 and the declared protocol is v0.9; 1 means unsupported or
unverifiable and requires review; 2 means invalid input. It emits a
fixed-label JSON diagnostic without manifest values or paths. A caret
range, transitive-only dependency, conflicting peer declaration, 0.15
SDK, or v1.0 protocol cannot receive a false passing verdict.

**Passing is only permission to attempt a real browser comparison**, not
proof of the installed package graph, lockfile, generated capture or
third-party compatibility. The separately immutable-pinned, manually
copied [workflow](workflow.yml) does not yet execute this new preflight;
run it yourself as an opt-in prerequisite. In particular do not force
Zod4 or npm peer-dependency overrides to make an unsupported pair appear
compatible. No npm registry calls or paid services are involved in
the preflight.

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
node src/browser-capture-error-boundary-compare.mjs --before-capture fixtures/lifecycle-v09.jsonl --after-capture examples/consumer-ci/after.jsonl --require-no-observed-failures --compare-rendered-text --compare-button-geometry --compare-button-focus --strict --report-dir out/consumer-one-pair-demo
```

Expected result: exit **1** because Text drift is observed at event 2, although
both replays have **no observed failures**. The combined `comparison.json`
includes `observedFailuresAbsent: true`, `renderedTextParity: "drift"`, and
`firstDifferentRenderedTextEventIndex: 2`. The combined JUnit file
`comparison.xml` fails its rendered-Text assertion without a second Chromium
pair. Geometry and Tab-focus reachability are also measured, but the Text-only
fixture contains no Button, so these assertions here are baseline controls. If either replay fails,
Text, Button geometry and Tab-focus parity are reported as **unavailable**, not
misleadingly marked matching; strict failure policy remains enforced.
A malformed capture or output collision exits **2**. An existing report
directory is never overwritten. Transient HMACs stay inside the comparator
and its child processes and are not saved with reports.

For a real layout-only regression, compare the public Column-versus-Row pair.
The Button moves in the published React/Chromium renderer even though event
counts and observed replay health match. No Button action is activated:

```sh
node src/browser-capture-error-boundary-compare.mjs --before-capture examples/consumer-ci/geometry-before.jsonl --after-capture examples/consumer-ci/geometry-after.jsonl --require-no-observed-failures --compare-button-geometry --compare-button-focus --strict --report-dir out/consumer-geometry-demo
```

Expected exit **1** with `observedFailuresAbsent: true`,
`buttonGeometryParity: "drift"` and
`firstDifferentButtonGeometryEventIndex: 1`. Reports never include raw
coordinates, private labels or reusable digests. Geometry is quantized
to CSS pixels at a fixed Chromium viewport; the same pass also samples real
keyboard Tab reachability without activating Buttons. This is **not** screenshot
or cross-browser pixel parity, and its measurement overhead is unbenchmarked.

All public demonstration scenarios run in the existing `react-browser` CI job using the published
renderer, not a mocked DOM or unverified example command.

## Adapt the GitHub Actions recipe

The template is [`workflow.yml`](workflow.yml). Copy it into **your**
repository under `.github/workflows/a2ui-compare.yml` and review its
contents. It is deliberately **manual** (`workflow_dispatch`) until you
supply trusted capture generation. Replace `ci/a2ui-before.jsonl` and
`ci/a2ui-after.jsonl` with paths produced by your application's own
capture step. The example does not invent capture tooling and will fail
closed when those files are missing.

The workflow checks out the lab at an **immutable source commit containing the verified no-action Button geometry and Tab-focus runtime** (source-head React browser CI passed), installs
the isolated published React/core dependencies, then uses a single
`--require-no-observed-failures --compare-rendered-text --compare-button-geometry --compare-button-focus --strict --report-dir`
comparison. Observed replay failures, rendered-Text drift, Button relocation or changed
Tab reachability fail CI. A disabled Button may become unreachable while
Text and structural counts stay identical; the real Chromium regression test
uses that exact case. Event indices and fixed parity labels are reported,
never private focus targets or reusable fingerprints.
It creates three combined reports with **one** Chromium pair; there is no
second rendered-Text JUnit file. Other UI properties (such as emitted action payload parity and complete accessibility behavior) are not covered by this starter.

By default, the workflow **does not** upload artifacts or add a GitHub step
summary. The generated JSON, Markdown and combined JUnit reports live only in the
runner's temporary directory. After you inspect your capture metadata and
decide publication is acceptable, explicitly set the repository Actions
variable `A2UI_SHARE_COMPARISON_METADATA=true` to enable a one-day
artifact and step summary. The optional artifact also includes the Text
parity assertion inside the combined JUnit report; the step summary shows
the combined health, Text, geometry and Tab-focus Markdown.
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
