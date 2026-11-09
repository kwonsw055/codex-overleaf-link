const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const extensionRoot = process.env.CODEX_OVERLEAF_TEST_EXTENSION_ROOT
  || path.resolve(__dirname, '../extension');
const read = file => fs.readFileSync(path.join(extensionRoot, 'src', file), 'utf8');

function harness(overrides = {}) {
  const state = { reviewing: false, calls: [], applied: [] };
  const context = vm.createContext({
    window: {}, treeOperations: {},
    ensureReviewing: async () => { state.calls.push('reviewing'); state.reviewing = true; return { ok: true }; },
    ensureEditing: async () => { state.calls.push('editing'); state.reviewing = false; return { ok: true, activated: true }; },
    setReviewingEnabled: async enabled => {
      state.calls.push(enabled ? 'reviewing' : 'editing');
      state.reviewing = enabled;
      return { ok: true, enabled, changed: true };
    },
    summarizeReviewingToggleResult: value => value,
    buildReviewingRequiredBlockedResult: (operations, reviewing) => ({ ok: false, applied: [], skipped: operations, reviewing }),
    buildEditingRequiredBlockedResult: () => ({ ok: false, applied: [], skipped: [] }),
    applyOperationsCore: async (operations, options) => {
      assert.equal(state.reviewing, options.trackReviewingChanges);
      state.applied.push(...operations);
      return { ok: true, applied: operations, skipped: [], trackedChanges: [{ id: 'change-1' }] };
    },
    ...overrides
  });
  const source = read('page/writebackRouter.js');
  vm.runInContext(extractFunction(source, 'applyOperations') + '\n' + extractFunction(source, 'returnToEditingAfterWrite'), context);
  return { state, context };
}
const operations = [{ type: 'edit', path: 'main.tex', find: 'before', replace: 'after' }];

test('tracked writes return to Editing and preserve applied entries and tracked references', async () => {
  const { state, context } = harness();
  const result = await context.applyOperations(operations, { requireReviewing: true });
  assert.equal(result.ok, true);
  assert.equal(state.reviewing, false);
  assert.deepEqual(state.calls, ['reviewing', 'editing']);
  assert.deepEqual(result.applied, operations);
  assert.equal(result.trackedChanges[0].id, 'change-1');
  assert.equal(result.reviewingPolicy.leftEditing, true);
});

test('Reviewing stays on until an in-flight write finishes, then returns to Editing', async () => {
  let finishWrite;
  let started;
  const writeStarted = new Promise(resolve => { started = resolve; });
  const { state, context } = harness({
    applyOperationsCore: () => new Promise(resolve => { finishWrite = resolve; started(); })
  });
  const pending = context.applyOperations(operations, { requireReviewing: true });
  await writeStarted;
  assert.equal(state.reviewing, true);
  finishWrite({ ok: true, applied: operations, skipped: [] });
  await pending;
  assert.equal(state.reviewing, false);
});

for (const code of ['stale_snapshot', 'codex_cancelled', 'file_open_failed']) {
  test(`returns to Editing after ${code}`, async () => {
    const { state, context } = harness({
      applyOperationsCore: async () => ({ ok: false, applied: [], skipped: [{ result: { code } }] })
    });
    const result = await context.applyOperations(operations, { requireReviewing: true });
    assert.equal(result.skipped[0].result.code, code);
    assert.equal(state.reviewing, false);
    assert.equal(result.reviewingPolicy.leftEditing, true);
  });
}

test('returns to Editing even when a write throws, preserving the original error', async () => {
  const original = new Error('write failed');
  const { state, context } = harness({ applyOperationsCore: async () => { throw original; } });
  await assert.rejects(context.applyOperations(operations, { requireReviewing: true }), error => error === original);
  assert.equal(state.reviewing, false);
});

test('cleans up partially activated Reviewing when activation fails', async () => {
  const { state, context } = harness();
  context.ensureReviewing = async () => { state.reviewing = true; return { ok: false }; };
  const result = await context.applyOperations(operations, { requireReviewing: true });
  assert.equal(result.ok, false);
  assert.equal(state.applied.length, 0);
  assert.equal(state.reviewing, false);
});

test('cleanup errors preserve successful writes and reach the presenter through batch merging', async () => {
  const { context } = harness({ setReviewingEnabled: async () => { throw new Error('mode unavailable'); } });
  const result = await context.applyOperations(operations, { requireReviewing: true });
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.reviewingPolicy.leftEditing, false);
  assert.equal(result.reviewingPolicy.disable.reason, 'mode unavailable');
  const { mergeApplyResults } = require(path.join(extensionRoot, 'src/content/assetTransferBroker'));
  const merged = mergeApplyResults([result, { ok: true, applied: [], skipped: [], reviewingPolicy: { leftEditing: true } }]);
  assert.equal(merged.reviewingPolicy.leftEditing, false);
  const events = [];
  const presenterContext = vm.createContext({ window: {} });
  vm.runInContext(read('content/applyResultFormatters.js'), presenterContext);
  const presenter = presenterContext.window.CodexOverleafApplyResultFormatters.create({
    tx: en => en, tr: key => key, getAppliedEntries: value => value.applied,
    getSkippedEntries: value => value.skipped, appendRunEvent: event => events.push(event)
  });
  // Use an empty applied list here; this assertion concerns the cleanup warning.
  presenter.appendApplyResult({ ...merged, applied: [] });
  assert.equal(events[0].status, 'warning');
  assert.match(events[0].title, /return Overleaf to Editing/);
});

test('cleanup never toggles a different project after navigation', async () => {
  const { state, context } = harness({
    window: { CodexOverleafWriteGuard: { create: () => ({ runWriteGuard: async () => ({
      skipped: [{ result: { ok: false, code: 'aborted_project_changed' } }]
    }) }) } }
  });
  const result = await context.applyOperations(operations, { requireReviewing: true, runProjectId: 'original' });
  assert.deepEqual(state.calls, ['reviewing']);
  assert.equal(result.reviewingPolicy.disable.code, 'aborted_project_changed');
});

test('empty and untracked writes never enable Reviewing', async () => {
  const { state, context } = harness();
  await context.applyOperations([], { requireReviewing: true });
  assert.deepEqual(state.calls, []);
  await context.applyOperations(operations, { requireEditing: true });
  assert.deepEqual(state.calls, ['editing']);
  assert.equal(state.reviewing, false);
});

for (const mode of ['auto', 'ask']) {
  for (const requireReviewing of [true, false]) {
    test(`${mode} preflight keeps Editing while Codex thinks (Track=${requireReviewing})`, async () => {
      const calls = [];
      const context = vm.createContext({
        state: { mode, requireReviewing }, currentRunView: { runProjectId: 'project' },
        tx: en => en, appendRunEvent() {},
        callPageBridge: async (method, params) => { calls.push({ method, params }); return { ok: true, activated: true }; }
      });
      vm.runInContext(extractFunction(read('content/contentRuntime.js'), 'preflightWriteSafety'), context);
      const result = await context.preflightWriteSafety({ mode, requireReviewing });
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'ensureEditing');
      assert.equal(calls[0].params.runProjectId, 'project');
    });
  }
}

test('an idle editor in Editing is ready without asking the user to turn Reviewing on', () => {
  const context = vm.createContext({
    state: { mode: 'auto', requireReviewing: true },
    getActiveFocusFiles: () => [], tr: key => key, tx: en => en,
    appendOtStatusToProbeStatus: value => value
  });
  const source = read('content/contentRuntime.js');
  for (const name of ['getProbeRunReadiness', 'isProbeReadyForCurrentMode', 'formatProbeStatusBar', 'formatProbeUserNotice']) {
    vm.runInContext(extractFunction(source, name), context);
  }
  const probe = { editor: { ok: true }, reviewing: { ok: false } };
  assert.equal(context.isProbeReadyForCurrentMode(probe), true);
  assert.match(context.formatProbeStatusBar(probe), /canRun/);
  const notice = context.formatProbeUserNotice(probe);
  assert.equal(notice.ready, true);
  assert.match(notice.message, /only while applying changes/);
});
