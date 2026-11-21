import assert from 'node:assert/strict';

// Public deterministic example. Client-to-server actions are intentionally NOT
// agent updateDataModel messages; persisted agent history alone cannot replay
// a renderer-local two-way-bound input change.
const surfaceId = 'history-replay';
const agentMessages = [
  {version: 'v0.9', createSurface: {surfaceId, catalogId: '__BASIC_CATALOG__'}},
  {version: 'v0.9', updateComponents: {surfaceId, components: [
    {id: 'root', component: 'Column', children: ['choice', 'submit']},
    {id: 'choice', component: 'TextField', label: 'Choice',
      value: {path: '/choice'}, variant: 'shortText'},
    {id: 'submit', component: 'Button', child: 'submit-label', variant: 'primary',
      action: {event: {name: 'submit-choice', context: {choice: {path: '/choice'}}}}},
    {id: 'submit-label', component: 'Text', text: 'Submit choice'},
  ]}},
  {version: 'v0.9', updateDataModel: {surfaceId, path: '/', value: {choice: 'alpha'}}},
];

// Host-side fixture policy, not an A2UI protocol message or general binding inverter.
// Derive exactly one absolute-path write from a trusted agent-defined Button event
// and the client action recorded in the conversation stream. Refuse ambiguity.
function deriveFixtureActionUpdate(action, messages) {
  assert.equal(action.surfaceId, surfaceId, 'Recorded action must target this surface');
  assert.equal(action.sourceComponentId, 'submit', 'Recorded action must target this Button');
  assert.equal(action.name, 'submit-choice', 'Recorded action event must match');
  // A persisted deletion ends this fixture surface lifetime. Old Button actions
  // must not be replayed into a deleted or recreated instance with the same ID.
  assert.ok(!messages.some(message => message.deleteSurface?.surfaceId === surfaceId),
    'Refuse optimistic action replay after surface deletion');
  assert.deepEqual(Object.keys(action.context ?? {}).sort(), ['choice'],
    'Refuse unbound or extra action context');
  assert.equal(typeof action.context.choice, 'string', 'Fixture expects text input');
  const componentMessages = messages.filter(message =>
    message.updateComponents?.surfaceId === surfaceId);
  assert.equal(componentMessages.length, 1, 'Ambiguous component history');
  const buttons = componentMessages[0].updateComponents.components.filter(component =>
    component.id === action.sourceComponentId);
  assert.equal(buttons.length, 1, 'Action Button must be unambiguous');
  const button = buttons[0];
  assert.equal(button.component, 'Button');
  assert.equal(button.action?.event?.name, action.name);
  const binding = button.action.event.context?.choice;
  assert.deepEqual(binding, {path: '/choice'},
    'Only the known absolute-path binding is eligible for this fixture policy');
  return {version: 'v0.9', updateDataModel: {
    surfaceId, path: binding.path, value: action.context.choice,
  }};
}

async function mountAgentHistory(page, origin) {
  await page.goto(origin + '/?capture=1', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.__a2uiLab?.trace), null, {timeout: 10000});
  // The capture-mode React root subscribes to surface creation in useEffect.
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(messages => {
    for (const message of messages) window.__a2uiLab.applyMessage(message);
  }, agentMessages);
  // The pinned React catalog may not expose TextField's label as an HTML accessible name.
  // The fixture has exactly one native editable control; test its actual DOM state.
  const input = page.locator('input, textarea');
  await input.first().waitFor({state: 'visible', timeout: 10000});
  assert.equal(await input.count(), 1, 'Fixture must mount exactly one native input');
  assert.equal(await input.inputValue(), 'alpha',
    'Agent-created form starts from the last persisted updateDataModel');
  return input;
}

async function waitForModel(page, choice) {
  await page.waitForFunction(({surfaceId, choice}) =>
    window.__a2uiLab.trace(surfaceId).data?.choice === choice,
  {surfaceId, choice}, {timeout: 5000});
}

// Uses the caller's existing offline Chromium context and localhost-only route.
// No model values, actions or private captures are written to CI artifacts.
export async function testMessageOnlyHistoryReplay(context, origin) {
  const observedErrors = [];
  let live;
  let rebuilt;
  let optimistic;
  const watch = page => {
    page.on('pageerror', error => observedErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') observedErrors.push(message.text());
    });
  };
  try {
    live = await context.newPage();
    watch(live);
    const originalInput = await mountAgentHistory(live, origin);
    await originalInput.fill('beta');
    await waitForModel(live, 'beta');
    await live.getByRole('button', {name: 'Submit choice'}).click();
    await live.waitForFunction(() =>
      window.__a2uiLab.trace().actions.length === 1, null, {timeout: 5000});
    const action = (await live.evaluate(() => window.__a2uiLab.trace())).actions[0];
    assert.equal(action.name, 'submit-choice');
    assert.equal(action.surfaceId, surfaceId);
    assert.deepEqual(action.context, {choice: 'beta'});
    await live.close();
    live = null;

    // Simulate a host rebuilding from persisted AGENT A2UI messages. Its saved
    // client action is evidence of the choice, not a MessageProcessor mutation.
    rebuilt = await context.newPage();
    watch(rebuilt);
    const replayedInput = await mountAgentHistory(rebuilt, origin);
    assert.equal(await replayedInput.inputValue(), 'alpha');
    assert.equal((await rebuilt.evaluate(id => window.__a2uiLab.trace(id).data,
      surfaceId)).choice, 'alpha', 'Message-only replay lacks the local edit');

    // An explicit host/agent echo is one possible policy, NOT normative A2UI.
    await rebuilt.evaluate(({surfaceId, choice}) =>
      window.__a2uiLab.applyMessage({version: 'v0.9',
        updateDataModel: {surfaceId, path: '/choice', value: choice}}),
    {surfaceId, choice: action.context.choice});
    await waitForModel(rebuilt, 'beta');
    assert.equal(await replayedInput.inputValue(), 'beta');

    // A later agent update remains authoritative over the illustrative echo.
    await rebuilt.evaluate(id => window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {surfaceId: id, path: '/choice', value: 'gamma'},
    }), surfaceId);
    await waitForModel(rebuilt, 'gamma');
    assert.equal(await replayedInput.inputValue(), 'gamma');

    // A second HOST policy needs no out-of-band metadata or agent echo:
    // rebuild from saved agent messages, then derive one optimistic write
    // from the saved client action and its trusted absolute-path binding.
    // This is NOT normative SDK behavior or a third-party host reproduction.
    assert.throws(() => deriveFixtureActionUpdate(
      {...action, surfaceId: 'other-surface'}, agentMessages));
    assert.throws(() => deriveFixtureActionUpdate(
      {...action, sourceComponentId: 'other-button'}, agentMessages));
    assert.throws(() => deriveFixtureActionUpdate(
      {...action, name: 'wrong-action'}, agentMessages));
    assert.throws(() => deriveFixtureActionUpdate(
      {...action, context: {choice: 'beta', secret: 'unexpected'}}, agentMessages));
    const unsafeMessages = structuredClone(agentMessages);
    unsafeMessages[1].updateComponents.components[2].action.event.context.choice =
      {literal: 'beta'};
    assert.throws(() => deriveFixtureActionUpdate(action, unsafeMessages));

    const deletedHistory = [...agentMessages,
      {version: 'v0.9', deleteSurface: {surfaceId}}];
    assert.throws(() => deriveFixtureActionUpdate(action, deletedHistory),
      /surface deletion/,
      'A saved Button action must not restore a deleted surface');

    const optimisticUpdate = deriveFixtureActionUpdate(action, agentMessages);
    optimistic = await context.newPage();
    watch(optimistic);
    const optimisticInput = await mountAgentHistory(optimistic, origin);
    await optimistic.evaluate(message => window.__a2uiLab.applyMessage(message),
      optimisticUpdate);
    await waitForModel(optimistic, 'beta');
    assert.equal(await optimisticInput.inputValue(), 'beta',
      'A saved client action restores state through an explicit host policy');
    await optimistic.evaluate(id => window.__a2uiLab.applyMessage({
      version: 'v0.9', updateDataModel: {surfaceId: id, path: '/choice', value: 'gamma'},
    }), surfaceId);
    await waitForModel(optimistic, 'gamma');
    assert.equal(await optimisticInput.inputValue(), 'gamma',
      'A subsequent agent message wins over the optimistic action-derived write');
    await optimistic.evaluate(id => window.__a2uiLab.applyMessage({
      version: 'v0.9', deleteSurface: {surfaceId: id},
    }), surfaceId);
    await optimistic.waitForFunction(id =>
      !window.__a2uiLab.trace().surfaceIds.includes(id),
    surfaceId, {timeout: 5000});
    await optimisticInput.first().waitFor({state: 'detached', timeout: 5000});
    assert.equal((await optimistic.evaluate(id =>
      window.__a2uiLab.trace(id), surfaceId)).data, null,
    'The deleted real React surface must not retain prior model data');
    assert.deepEqual(observedErrors, [], 'Real React pages must have no runtime errors');
    return {localInputActionObserved: true, messageOnlyStateLossObserved: true,
      explicitEchoRestored: true, laterAgentUpdateOverrides: true,
      optimisticActionReplayRestored: true, laterAgentOverrodeOptimisticReplay: true,
      unsupportedActionBindingRejected: true,
      staleDeletedSurfaceActionRejected: true,
      deletedSurfaceUnmountObserved: true};
  } finally {
    if (optimistic && !optimistic.isClosed()) await optimistic.close();
    if (rebuilt && !rebuilt.isClosed()) await rebuilt.close();
    if (live && !live.isClosed()) await live.close();
  }
}
