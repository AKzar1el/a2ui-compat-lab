import {Catalog, MessageProcessor} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';

const MAX_REPLAY_MESSAGES = 1000;

/**
 * Trusted local Catalog instances are explicitly supplied by the caller.
 * Captured A2UI JSON never loads code or registers an arbitrary catalog.
 */
export function createTrustedV09Processor({trustedCatalogs = [], onAction = () => {}} = {}) {
  if (!Array.isArray(trustedCatalogs))
    throw new TypeError('trustedCatalogs must be an array');
  if (typeof onAction !== 'function')
    throw new TypeError('onAction must be a function');

  const catalogs = [basicCatalog];
  const ids = new Set([basicCatalog.id]);
  for (const catalog of trustedCatalogs) {
    if (!(catalog instanceof Catalog))
      throw new TypeError('Only trusted published-SDK Catalog instances may be registered');
    const id = Object.getOwnPropertyDescriptor(catalog, 'id')?.value;
    const protocol = Object.getOwnPropertyDescriptor(catalog, 'protocolVersion')?.value;
    if (typeof id !== 'string' || !id.trim())
      throw new TypeError('Trusted catalog requires a nonempty own ID');
    if (protocol !== '0.9')
      throw new TypeError('Trusted catalog requires v0.9 protocol');
    if (ids.has(id))
      throw new Error('Duplicate catalog ID: registration refused');
    ids.add(id);
    catalogs.push(catalog);
  }
  return {
    processor: new MessageProcessor(catalogs, onAction),
    registeredCatalogIds: Object.freeze([...ids]),
  };
}

/**
 * Minimal offline state replay for custom-catalog v0.9 captures.
 * It does not simulate a browser click or execute renderer components.
 */
export function replayV09WithTrustedCatalogs(messages, {trustedCatalogs = []} = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_REPLAY_MESSAGES)
    throw new RangeError('Replay requires 1-1000 messages');
  const {processor, registeredCatalogIds} = createTrustedV09Processor({trustedCatalogs});
  const allowed = new Set(registeredCatalogIds);
  const snapshots = [];
  try {
    for (const [index, source] of messages.entries()) {
      const message = structuredClone(source);
      if (!message || typeof message !== 'object' || Array.isArray(message) ||
          message.version !== 'v0.9')
        throw new TypeError('Unsupported v0.9 replay message');
      const create = message.createSurface;
      if (create?.catalogId === '__BASIC_CATALOG__') create.catalogId = basicCatalog.id;
      if (create && !allowed.has(create.catalogId))
        throw new Error('Unregistered catalog ID in capture');
      const surfaceId = create?.surfaceId ??
        message.updateComponents?.surfaceId ??
        message.updateDataModel?.surfaceId ??
        message.deleteSurface?.surfaceId;
      if (typeof surfaceId !== 'string' || !surfaceId)
        throw new TypeError('Replay message must name one surface');
      processor.processMessages([message]);
      const surface = processor.getSurface(surfaceId);
      if (create && !surface)
        throw new Error('SDK rejected requested catalog surface');
      snapshots.push({
        index, surfaceId, exists: Boolean(surface),
        components: surface ? [...surface.componentsModel.keys] : [],
        data: surface ? (structuredClone(surface.dataModel.get('/')) ?? null) : null,
      });
    }
    return {protocol: 'v0.9', registeredCatalogIds, snapshots};
  } finally {
    // The published 0.15 processor's model outlives dispose() unless released.
    try { processor.model.dispose(); } finally { processor.dispose(); }
  }
}
