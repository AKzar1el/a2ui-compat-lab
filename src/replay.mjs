import {ComponentContext, GenericBinder, MessageProcessor} from '@a2ui/web_core/v0_9';
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
          data: surface ? structuredClone(surface.dataModel.get('/')) : null,
          actionCount: actions.length,
        });
        continue;
      }

      const {surfaceId, componentId} = step.tap ?? {};
      if (typeof surfaceId !== 'string' || !surfaceId ||
          typeof componentId !== 'string' || !componentId)
        throw new TypeError('Tap must name a surface and component at index ' + index);
      const surface = processor.getSurface(surfaceId);
      const component = surface?.componentsModel.get(componentId);
      if (!surface || !component || component.type !== 'Button')
        throw new Error('Tap target is not an active Button: ' + surfaceId + '/' + componentId);
      const schema = component.catalog?.components.get('Button')?.schema;
      if (!schema) throw new Error('Button catalog schema unavailable: ' + componentId);
      const binder = new GenericBinder(new ComponentContext(surface, componentId), schema);
      const before = actions.length;
      try {
        binder.subscribe(() => {});
        if (typeof binder.snapshot.action !== 'function')
          throw new Error('Button has no executable action: ' + componentId);
        await binder.snapshot.action();
      } finally {
        binder.dispose();
      }
      if (actions.length !== before + 1)
        throw new Error('Button must emit exactly one agent event: ' + componentId);
      snapshots.push({
        index, kind: 'tap', surfaceId, componentId, exists: true,
        components: [...surface.componentsModel.keys],
        data: structuredClone(surface.dataModel.get('/')),
        actionCount: actions.length,
      });
    }
    return {protocol: 'v0.9', snapshots, actions};
  } finally {
    processor.dispose();
  }
}
