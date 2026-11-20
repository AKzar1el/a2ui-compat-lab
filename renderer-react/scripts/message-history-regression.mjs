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

async function mountAgentHistory(page, origin) {
  await page.goto(origin + '/?capture=1', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.__a2uiLab?.trace), null, {timeout: 10000});
  // The capture-mode React root subscribes to surface creation in useEffect.
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(messages => {
    for (const message of messages) window.__a2uiLab.applyMessage(message);
  }, agentMessages);
  const input = page.getByRole('textbox', {name: 'Choice'});
  await input.waitFor({state: 'visible', timeout: 10000});
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
    assert.deepEqual(observedErrors, [], 'Real React pages must have no runtime errors');
    return {localInputActionObserved: true, messageOnlyStateLossObserved: true,
      explicitEchoRestored: true, laterAgentUpdateOverrides: true};
  } finally {
    if (rebuilt && !rebuilt.isClosed()) await rebuilt.close();
    if (live && !live.isClosed()) await live.close();
  }
}
