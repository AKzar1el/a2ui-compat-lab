import {ComponentContext, GenericBinder, MessageProcessor} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';

/** Bounded text JSONL parser used to fuzz chunk boundaries without a live agent. */
export function parseJsonLines(chunks, {maxLineBytes = 262144, maxMessages = 10000} = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('Invalid line limit');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new RangeError('Invalid message limit');
  let carry = '';
  let lineBytes = 0;
  let lastCodeUnit = -1;
  const messages = [];
  for (const chunk of chunks) {
    if (typeof chunk !== 'string') throw new TypeError('JSONL chunks must be strings');
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      // A surrogate pair split between chunks is 4 UTF-8 bytes, not 3 + 3.
      const joinedSurrogates = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff &&
        part.length > 0 && part.charCodeAt(0) >= 0xdc00 && part.charCodeAt(0) <= 0xdfff;
      lineBytes += Buffer.byteLength(part, 'utf8') - (joinedSurrogates ? 2 : 0);
      if (lineBytes > maxLineBytes) throw new RangeError('JSONL message exceeds byte limit');
      carry += part;
      if (part.length) lastCodeUnit = part.charCodeAt(part.length - 1);
      if (newline < 0) break;
      const raw = carry.trim();
      if (raw) {
        if (messages.length >= maxMessages) throw new RangeError('JSONL message count exceeds limit');
        messages.push(JSON.parse(raw));
      }
      carry = '';
      lineBytes = 0;
      lastCodeUnit = -1;
      start = newline + 1;
    }
  }
  if (carry.trim()) throw new SyntaxError('Incomplete trailing JSONL message');
  return messages;
}

/**
 * Parse transport-level JSONL bytes without replacing split or invalid UTF-8.
 * Newlines are ASCII delimiters, so a multi-byte code point can safely span
 * arbitrary network chunks while each complete line is decoded exactly once.
 */
export function parseJsonLinesBytes(chunks, {maxLineBytes = 262144, maxMessages = 10000} = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('Invalid line limit');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new RangeError('Invalid message limit');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const messages = [];
  let line = [];

  const decodeLine = () => decoder.decode(Uint8Array.from(line)).trim();
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('JSONL byte chunks must be Uint8Array or Buffer');
    for (const byte of chunk) {
      if (byte === 10) {
        const raw = decodeLine();
        line = [];
        if (raw) {
          if (messages.length >= maxMessages) throw new RangeError('JSONL message count exceeds limit');
          messages.push(JSON.parse(raw));
        }
      } else {
        if (line.length >= maxLineBytes) throw new RangeError('JSONL message exceeds byte limit');
        line.push(byte);
      }
    }
  }
  if (line.length && decodeLine()) throw new SyntaxError('Incomplete trailing JSONL message');
  return messages;
}

/** Exercise the real v0.9 A2UI MessageProcessor; intentionally NOT a browser renderer. */
export function replayV09(messages) {
  const actions = [];
  const processor = new MessageProcessor([basicCatalog], action => { actions.push(action); });
  const snapshots = [];
  try {
    for (const [index, source] of messages.entries()) {
      const message = structuredClone(source);
      if (message.createSurface?.catalogId === '__BASIC_CATALOG__')
        message.createSurface.catalogId = basicCatalog.id;
      processor.processMessages([message]);
      const surfaceId = message.createSurface?.surfaceId ??
        message.updateComponents?.surfaceId ?? message.updateDataModel?.surfaceId ??
        message.deleteSurface?.surfaceId ?? 'replay';
      const surface = processor.getSurface(surfaceId);
      snapshots.push({
        index, surfaceId,
        exists: Boolean(surface),
        components: surface ? [...surface.componentsModel.keys] : [],
        data: surface ? (structuredClone(surface.dataModel.get('/')) ?? null) : null,
        actionCount: actions.length,
      });
    }
    return {protocol: 'v0.9', snapshots, actionCount: actions.length};
  } finally {
    processor.dispose();
  }
}

/** Resolve a Button's currently rendered instance, not just a registered component ID. */
function reachableButtonPath(surface, componentId, requestedBasePath) {
  const pending = [{id: surface.rootId, basePath: '/', templated: false}];
  const seen = new Set();
  const matches = [];
  while (pending.length) {
    const {id, basePath, templated} = pending.pop();
    if (typeof id !== 'string' || typeof basePath !== 'string') continue;
    const key = JSON.stringify([id, basePath]);
    if (seen.has(key)) continue;
    seen.add(key);
    const node = surface.componentsModel.get(id);
    if (!node) continue;
    if (id === componentId) {
      matches.push({basePath, templated});
      continue;
    }
    const push = ref => {
      if (typeof ref === 'string') pending.push({id: ref, basePath, templated});
    };
    const {child, children, trigger, content, tabs} = node.properties ?? {};
    push(child);
    push(trigger);
    // Closed Modal content and inactive Tabs have no visible headless interaction.
    if (node.type !== 'Modal') push(content);
    if (Array.isArray(children)) {
      for (const ref of children) push(ref);
    } else if (['Column', 'Row', 'List'].includes(node.type) &&
               typeof children?.componentId === 'string' && typeof children.path === 'string') {
      // Ask the published SDK to materialize current template members. Numeric
      // paths are current row indices, never durable identities across reorders.
      const schema = node.catalog?.components.get(node.type)?.schema;
      if (schema) {
        const binder = new GenericBinder(new ComponentContext(surface, id, basePath), schema);
        try {
          binder.subscribe(() => {});
          const resolved = binder.snapshot.children;
          if (Array.isArray(resolved)) {
            for (const ref of resolved) {
              if (typeof ref?.id === 'string' && typeof ref.basePath === 'string')
                pending.push({id: ref.id, basePath: ref.basePath, templated: true});
            }
          }
        } finally {
          binder.dispose();
        }
      }
    }
    if (Array.isArray(tabs)) {
      const visibleTabs = node.type === 'Tabs' ? tabs.slice(0, 1) : tabs;
      for (const tab of visibleTabs) push(tab?.child);
    }
  }
  // Legacy ID-only taps must not silently select one of multiple template rows.
  if (requestedBasePath === undefined)
    return matches.length === 1 && !matches[0].templated ? matches[0].basePath : null;
  const selected = matches.filter(item => item.templated && item.basePath === requestedBasePath);
  return selected.length === 1 ? selected[0].basePath : null;
}

/**
 * Replays agent messages and renderer-side Button actions through the real
 * v0.9 core's binder. This is headless interaction coverage, not a DOM click.
 */
export async function replayV09Actions(steps) {
  if (!Array.isArray(steps)) throw new TypeError('Replay steps must be an array');
  const actions = [];
  const processor = new MessageProcessor([basicCatalog], action => {
    // The SDK timestamps outbound events; omit only that nondeterministic field.
    const {timestamp, ...stableAction} = action;
    actions.push(structuredClone(stableAction));
  });
  const snapshots = [];
  try {
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step))
        throw new TypeError('Invalid replay step at index ' + index);
      const keys = Object.keys(step);
      if (keys.length !== 1 || !['message', 'tap'].includes(keys[0]))
        throw new TypeError('Replay step must contain exactly one message or tap at index ' + index);

      if (keys[0] === 'message') {
        const message = structuredClone(step.message);
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new TypeError('Invalid A2UI message at index ' + index);
        if (message.createSurface?.catalogId === '__BASIC_CATALOG__')
          message.createSurface.catalogId = basicCatalog.id;
        processor.processMessages([message]);
        const surfaceId = message.createSurface?.surfaceId ??
          message.updateComponents?.surfaceId ?? message.updateDataModel?.surfaceId ??
          message.deleteSurface?.surfaceId;
        if (typeof surfaceId !== 'string' || !surfaceId)
          throw new TypeError('Replay message must name a surface at index ' + index);
        const surface = processor.getSurface(surfaceId);
        snapshots.push({
          index, kind: 'message', surfaceId, exists: Boolean(surface),
          components: surface ? [...surface.componentsModel.keys] : [],
          data: surface ? (structuredClone(surface.dataModel.get('/')) ?? null) : null,
          actionCount: actions.length,
        });
        continue;
      }

      const tap = step.tap;
      if (!tap || typeof tap !== 'object' || Array.isArray(tap) ||
          Object.keys(tap).some(key => !['surfaceId', 'componentId', 'basePath'].includes(key)))
        throw new TypeError('Tap contains unrecognized fields or invalid shape at index ' + index);
      const {surfaceId, componentId, basePath} = tap;
      if (typeof surfaceId !== 'string' || !surfaceId ||
          typeof componentId !== 'string' || !componentId)
        throw new TypeError('Tap must name a surface and component at index ' + index);
      if (basePath !== undefined &&
          (typeof basePath !== 'string' || !basePath.startsWith('/') || basePath === '/'))
        throw new TypeError('Tap basePath must be an absolute template instance path at index ' + index);
      const surface = processor.getSurface(surfaceId);
      const component = surface?.componentsModel.get(componentId);
      const liveBasePath = surface && component?.type === 'Button'
        ? reachableButtonPath(surface, componentId, basePath) : null;
      if (!surface || !component || component.type !== 'Button' || liveBasePath === null)
        throw new Error('Tap target is not an active Button: ' + surfaceId + '/' + componentId);
      const schema = component.catalog?.components.get('Button')?.schema;
      if (!schema) throw new Error('Button catalog schema unavailable: ' + componentId);
      const binder = new GenericBinder(new ComponentContext(surface, componentId, liveBasePath), schema);
      const before = actions.length;
      try {
        binder.subscribe(() => {});
        if (binder.snapshot.isValid === false)
          throw new Error('Button failed validation checks: ' + componentId);
        if (typeof binder.snapshot.action !== 'function')
          throw new Error('Button has no executable action: ' + componentId);
        await binder.snapshot.action();
      } finally {
        binder.dispose();
      }
      if (actions.length !== before + 1)
        throw new Error('Button must emit exactly one agent event: ' + componentId);
      snapshots.push({
        index, kind: 'tap', surfaceId, componentId,
        ...(basePath === undefined ? {} : {basePath}), exists: true,
        components: [...surface.componentsModel.keys],
        data: structuredClone(surface.dataModel.get('/')) ?? null,
        actionCount: actions.length,
      });
    }
    return {protocol: 'v0.9', snapshots, actions};
  } finally {
    processor.dispose();
  }
}

/** A headless failure/recovery trace; rejected messages must not silently mutate known surfaces. */
export function replayV09Recoverable(messages) {
  if (!Array.isArray(messages)) throw new TypeError('Replay messages must be an array');
  const actions = [];
  const processor = new MessageProcessor([basicCatalog], action => { actions.push(action); });
  const seenSurfaceIds = new Set();
  const events = [];
  let rejectedCount = 0;
  let unsafeRecovery = false;

  function snapshot(surfaceId) {
    const surface = surfaceId === null ? null : processor.getSurface(surfaceId);
    return {
      exists: Boolean(surface),
      components: surface ? [...surface.componentsModel.keys] : [],
      data: surface ? (structuredClone(surface.dataModel.get('/')) ?? null) : null,
    };
  }

  function observedState() {
    return {
      surfaces: [...seenSurfaceIds].sort().map(id => [id, snapshot(id)]),
      actionCount: actions.length,
    };
  }

  try {
    for (const [index, source] of messages.entries()) {
      let operation = 'invalid';
      let surfaceId = null;
      let error = null;
      let errorSource = null;
      let before = observedState();
      try {
        const message = structuredClone(source);
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new TypeError('A2UI message must be an object');
        const key = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']
          .find(name => Object.hasOwn(message, name));
        if (!key) throw new TypeError('Unknown A2UI operation');
        operation = key;
        surfaceId = typeof message[key]?.surfaceId === 'string' ? message[key].surfaceId : null;
        if (surfaceId !== null) seenSurfaceIds.add(surfaceId);
        if (message.createSurface?.catalogId === '__BASIC_CATALOG__')
          message.createSurface.catalogId = basicCatalog.id;
        before = observedState();
        try {
          processor.processMessages([message]);
        } catch (cause) {
          errorSource = 'sdk';
          throw cause;
        }
      } catch (cause) {
        error = {name: cause?.name ?? 'Error', message: String(cause?.message ?? cause)};
        errorSource ??= 'input';
        rejectedCount++;
      }
      const after = observedState();
      const mutationOnReject = error !== null && JSON.stringify(before) !== JSON.stringify(after);
      unsafeRecovery ||= mutationOnReject;
      events.push({
        index, operation, surfaceId, outcome: error ? 'rejected' : 'applied',
        errorSource, error, mutationOnReject,
        state: snapshot(surfaceId), actionCount: actions.length,
      });
      // Continuing after a partly applied rejected event would hide corrupted state.
      if (unsafeRecovery) break;
    }
    return {
      protocol: 'v0.9', events, actionCount: actions.length,
      appliedCount: events.length - rejectedCount, rejectedCount,
      safeToContinue: !unsafeRecovery, halted: unsafeRecovery,
    };
  } finally {
    processor.dispose();
  }
}
