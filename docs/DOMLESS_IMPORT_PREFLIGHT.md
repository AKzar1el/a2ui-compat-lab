# Published browser-condition imports without a DOM

A real React Native A2UI consumer reported that `@a2ui/web_core@0.15.0`
exposes basic v1 catalogs through Lit custom-element imports. With the
`browser` resolver condition but **no global `HTMLElement`**, these entrypoints
throw on import. See [upstream issue #4238](https://github.com/a2ui-project/a2ui/issues/4238)
and [unmerged fix PR #4239](https://github.com/a2ui-project/a2ui/pull/4239),
which proposes a Lit-free `catalogs/basic/v1/api` export. This new export
is **not present** in published web_core 0.15.0.

This Lab probes **the installed, published package**, not an upstream source
checkout. Run from a clean Lab installation (`npm ci`):

```sh
node src/domless-browser-import-preflight.mjs
node src/domless-browser-import-preflight.mjs --strict
```

The first command reports fixed-field JSON and exits zero for the documented
DOM requirement. `--strict` exits 1 when any probed import needs a DOM.
Unexpected import, runner, or timeout failures exit 2. Each import runs in a
separate bounded Node subprocess with `--conditions=browser`, an empty DOM and
no network requests by the Lab itself. Only four fixed SDK entrypoints are
permitted: `processing` as an importable control, the proposed Lit-free
`catalogs/basic/v1/api`, and the legacy `catalogs/basic/v1` and `v1_0`.
The report distinguishes `not-exported` from `dom-required`. The proposed
Lit-free API is `loaded` only when its module import also exposes the proposed
v1 component, function and theme contract (`ButtonApi`, `TextApi`,
`BASIC_COMPONENTS` with at least 18 items, nonempty `BASIC_FUNCTIONS`,
`BASIC_FUNCTION_APIS`, `createBasicCatalogFunctions` and
`BasicCatalogThemeSchema`; the Button API must be listed in `BASIC_COMPONENTS`).
An importable but
incomplete API reports `incomplete-api`; `--strict` fails until the processing
control and complete API load. `preferredEntrypoint` is advertised only on a
successfully loaded API;
legacy Lit exports need not become DOM-free for this result to improve. No private app files, source paths, stacks or values enter reports.

This is a **developer portability preflight**, not an A2UI conformance
certificate, React Native/Metro/Hermes execution, exploit proof or direct
runtime fix. The known published 0.15.0 failure is an **observed compatibility
gap**, not a newly discovered upstream bug. Recheck official SDK releases
and rerun this test before changing any baseline or claiming the gap is fixed.
