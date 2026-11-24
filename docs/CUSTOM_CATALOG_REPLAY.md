# Opt-in trusted custom v0.9 catalog replay

For developer-authored local Catalog instances, `src/replay-catalogs.mjs` provides
`createTrustedV09Processor` and `replayV09WithTrustedCatalogs`. Both use
the installed published `@a2ui/web_core@0.15.0` library and default to the
built-in basic catalog. They do **not** load a catalog, schema, or executable
code from untrusted JSONL captures.

```js
import {replayV09WithTrustedCatalogs} from './src/replay-catalogs.mjs';
// 'customCatalog' must be created by your trusted application code.
const result = replayV09WithTrustedCatalogs(myMessages, {
  trustedCatalogs: [customCatalog],
});
console.log(result.snapshots);
```

Caller-supplied catalogs must be actual published v0.9 `Catalog` instances.
Registration rejects empty IDs, protocol mismatches, duplicate custom IDs,
and collisions with the built-in basic ID, irrespective of order or object
identity. An unknown catalog ID referenced in a capture fails closed.
The `__BASIC_CATALOG__` replay alias remains accepted for the built-in ID.

This is a **headless state and SDK-action building block**, not an arbitrary
component renderer. The helper `createTrustedV09Processor` supplies a real
MessageProcessor to callers who need binder-driven actions; callers own
`processor.model.dispose()` and `processor.dispose()` in their cleanup.
The minimal `replayV09WithTrustedCatalogs` wrapper records component and
data snapshots for 1-1000 in-memory messages and releases both processor
and model. It does not simulate clicks. Neither component visualization nor
HotGrid rendering in Chromium is asserted. The React harness remains pinned
to the strict-compatible 0.14 pair and needs separate version-specific
custom-component registration.

See issue #191 for the real-world public custom-catalog pattern, upstream
version boundary, and synthetic published-SDK test evidence. This does not
establish adoption, customer demand, sales, or an upstream SDK security bug.

## Separate pinned React example

The browser harness also has an opt-in, bundled synthetic `LabConfirm`
component using the published React/core 0.14.0 pair. Open capture mode
with `?capture=1&trusted-custom-catalog=1` to register the fixed example
catalog ID `https://example.invalid/a2ui/lab-react/v0_9`. Ordinary capture
mode remains basic-only. The flag selects trusted compiled code; capture
messages never import code, fetch catalogs, or register executable objects.

The Chromium regression checks rejection when registration is absent,
real custom React DOM, two pointer clicks with changed data-bound action
context, surface deletion and an independent basic-catalog control.
The regression also exercises a required check on the custom component:
empty/nonempty/empty model updates, native disabled pointer and keyboard
suppression, and focused Enter/Space with exact current action context.
This is a bundled example, not arbitrary custom-renderer loading or a
claim of Handsontable compatibility. Verification requires the exact-head
hosted browser job; no local browser execution is claimed.

### Concurrent surface isolation regression

The opt-in Chromium suite also exercises two simultaneous custom surfaces
with the same catalog, component IDs and binding paths, alongside a basic
surface. It checks surface-specific action context, validation isolation,
physical pointer suppression on only the invalid surface, deletion and
recreation of the same surface ID, surviving button DOM identity, and an
independent basic-surface update. The new regression is not evidence until
its exact-head hosted Chromium job passes. It does not exercise multiple
different custom renderer catalog IDs or establish security isolation.

Seed model data before mounting a checked component: the published 0.14
resolver emits an expression error when `required` receives an unresolved
path, whereas an explicitly empty string is an ordinary invalid value.
The test retains zero-error assertions and verifies a newly created surface
starts with no model data or components before populating it.

### Distinct trusted function catalogs

The same opt-in registers two fixed synthetic function catalogs:
`https://example.invalid/a2ui/lab-function-a/v0_9` and
`https://example.invalid/a2ui/lab-function-b/v0_9`. Both define
`labScopedLabel`, but return different prefixes for the same bound input.
The hosted Chromium regression checks simultaneous actual Text rendering,
surface-local reactive updates, deletion and recreation, preserved surviving
DOM identity, and a basic-catalog negative control with recovery. Expected
negative-control SDK errors are distinct from the zero-error positive path.
No arbitrary functions are loaded from captures. This is a regression
example, not security isolation certification. Exact-head CI is required.
