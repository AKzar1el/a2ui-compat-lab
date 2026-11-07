import {MessageProcessor} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';

/** Deliberately narrow JSONL parser used to fuzz message chunk boundaries without a live agent. */
export function parseJsonLines(chunks, {maxLineBytes = 262144} = {}) {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) throw new RangeError('Invalid line limit');
  let carry = '';
  const messages = [];
  for (const chunk of chunks) {
    if (typeof chunk !== 'string') throw new TypeError('JSONL chunks must be strings');
    carry += chunk;
    let idx;
    while ((idx = carry.indexOf('\n')) >= 0) {
      const raw = carry.slice(0, idx).trim();
      if (Buffer.byteLength(raw, 'utf8') > maxLineBytes) throw new RangeError('JSONL message exceeds byte limit');
      carry = carry.slice(idx + 1);
      if (raw) messages.push(JSON.parse(raw));
    }
    if (Buffer.byteLength(carry, 'utf8') > maxLineBytes) throw new RangeError('Unterminated JSONL message exceeds byte limit');
  }
  if (carry.trim()) throw new SyntaxError('Incomplete trailing JSONL message');
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
        data: surface ? structuredClone(surface.dataModel.get('/')) : null,
        actionCount: actions.length,
      });
    }
    return {protocol: 'v0.9', snapshots, actionCount: actions.length};
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
      data: surface ? structuredClone(surface.dataModel.get('/')) : null,
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
