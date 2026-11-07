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

function applyMessage(source) {
  const message = structuredClone(source);
  if (message.createSurface?.catalogId === '__BASIC_CATALOG__')
    message.createSurface.catalogId = basicCatalog.id;
  processor.processMessages([message]);
}
for (const step of steps.slice(0, 3)) applyMessage(step.message);
const initial = processor.getSurface('action-replay');
if (!initial) throw new Error('Published SDK failed to create fixture surface');
initial.onError.subscribe(error => errors.push(structuredClone(error)));

window.__a2uiLab = Object.freeze({
  applyMessage,
  trace: () => ({
    actions: structuredClone(emitted),
    errors: structuredClone(errors),
    data: structuredClone(processor.getSurface('action-replay')?.dataModel.get('/') ?? null),
    components: [...(processor.getSurface('action-replay')?.componentsModel.keys ?? [])],
  }),
});

function App() {
  const [surfaces, setSurfaces] = useState(() => [...processor.model.surfacesMap.values()]);
  useEffect(() => {
    const sync = () => setSurfaces([...processor.model.surfacesMap.values()]);
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => { created.unsubscribe(); deleted.unsubscribe(); };
  }, []);
  return <section aria-label="Real A2UI surface">
    {surfaces.map(surface => <A2uiSurface key={surface.id} surface={surface}/>)}
  </section>;
}
createRoot(document.getElementById('app')).render(<App/>);
