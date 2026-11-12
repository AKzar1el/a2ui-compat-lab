import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {A2uiSurface} from '@a2ui/react/v0_9';
import {MessageProcessor} from '@a2ui/web_core/v0_9';
import {basicCatalog} from '@a2ui/web_core/v0_9/basic_catalog';
import steps from './fixture.json';

const emitted = [];
const errors = [];
const processor = new MessageProcessor([basicCatalog], action => {
  const {timestamp, ...stable} = action;
  emitted.push(structuredClone(stable));
});
// Capture mode has no initial surface; observe every dynamically created
// surface, without retaining potentially private SDK error payloads.
const observedErrorSurfaces = new WeakSet();
function observeSurfaceErrors(surface) {
  if (observedErrorSurfaces.has(surface)) return;
  observedErrorSurfaces.add(surface);
  surface.onError.subscribe(() => { errors.push('surface-error'); });
}

function applyMessage(source) {
  const message = structuredClone(source);
  if (message.createSurface?.catalogId === '__BASIC_CATALOG__')
    message.createSurface.catalogId = basicCatalog.id;
  processor.processMessages([message]);
  if (message.createSurface) {
    const surface = processor.getSurface(message.createSurface.surfaceId);
    if (surface) {
      observeSurfaceErrors(surface);
      // Opt-in synthetic SDK event for offline Chromium regression only.
      if (captureMode && surfaceErrorProbe) {
        void surface.dispatchError({code: 'TEST_SURFACE_ERROR', message: 'PRIVATE_SURFACE_ERROR_PROBE'});
      }
    }
  }
}
const captureMode = new URLSearchParams(window.location.search).get('capture') === '1';
const surfaceErrorProbe = captureMode &&
  new URLSearchParams(window.location.search).get('surface-error-probe') === '1';
if (!captureMode) for (const step of steps.slice(0, 3)) applyMessage(step.message);
const initial = processor.getSurface('action-replay');
if (!captureMode && !initial) throw new Error('Published SDK failed to create fixture surface');
if (initial) observeSurfaceErrors(initial);

window.__a2uiLab = Object.freeze({
  applyMessage,
  trace: (surfaceId = 'action-replay') => ({
    actions: structuredClone(emitted),
    errors: structuredClone(errors),
    surfaceIds: [...processor.model.surfacesMap.keys()].sort(),
    data: structuredClone(processor.getSurface(surfaceId)?.dataModel.get('/') ?? null),
    components: [...(processor.getSurface(surfaceId)?.componentsModel.keys ?? [])],
  }),
});

function App() {
  const [surfaces, setSurfaces] = useState(() => [...processor.model.surfacesMap.values()]);
  useEffect(() => {
    const sync = () => {
      const live = [...processor.model.surfacesMap.values()];
      live.forEach(observeSurfaceErrors);
      setSurfaces(live);
    };
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => { created.unsubscribe(); deleted.unsubscribe(); };
  }, []);
  return <section aria-label="Real A2UI surface">
    {surfaces.map(surface => <A2uiSurface key={surface.id} surface={surface}/>)}
  </section>;
}
createRoot(document.getElementById('app')).render(<App/>);
