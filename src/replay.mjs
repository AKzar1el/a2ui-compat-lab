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
