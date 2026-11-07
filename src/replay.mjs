import {MessageProcessor} from '@a2ui/web_core/v0_9';
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
