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
        data: surface ? structuredClone(surface.dataModel.get('/')) : null,
        actionCount: actions.length,
      });
    }
    return {protocol: 'v0.9', snapshots, actionCount: actions.length};
  } finally {
    processor.dispose();
  }
}
