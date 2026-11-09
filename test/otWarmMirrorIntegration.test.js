const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const test = require('node:test');
const Controller = require('../extension/src/content/otWarmMirrorController');
const Observer = require('../extension/src/page/overleafRealtimeObserver');

function createHarness(options = {}) {
  let state = { experimentalOtByProject: { example: true } };
  let content = 'Original text';
  let activePath = 'main.tex';
  let projectId = 'example';
  let busy = false;
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const document = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const observer = Observer.create({ document, window, getActiveFilePath: () => activePath,
    readActiveEditorText: () => content, ...options.observerOptions });
  const context = vm.createContext({ window, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/otWarmMirror.js'), 'utf8'), context);
  const mirror = window.CodexOverleafOtWarmMirror.create({
    // Exercise the retained legacy controller separately from production,
    // whose request-only default is covered below.
    backgroundSyncEnabled: true,
    otWarmMirrorController: Controller,
    getState: () => state, setState: next => { state = next; },
    getCurrentProjectId: () => projectId, getPanel: () => null,
    getCurrentRunView: () => busy ? {} : null, tr: key => key,
    updateProbeStatusOtSuffix() {}, saveStateSoon() {},
    callPageBridge: async method => JSON.parse(JSON.stringify(
      method === 'startOtObserver' ? observer.start()
        : method === 'stopOtObserver' ? observer.stop()
          : method === 'drainOtEvents' ? { ok: true, events: observer.drainEvents() }
            : observer.getStatus()
    )),
    ...options
  });
  return { mirror, observer, timers, listeners, document, window, setContent(value) { content = value; },
    setActivePath(value) { activePath = value; },
    setBusy(value) { busy = value; },
    setProject(value) { projectId = value; state.experimentalOtByProject[value] = true; },
    async runTimer(delay) {
      const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'expected a scheduled OT timer with delay ' + delay);
      timers.delete(entry[0]); entry[1].callback();
      await new Promise(setImmediate);
    }
  };
}

test('OT startup accepts the actual JSON page-bridge response and starts polling', async () => {
  const { mirror, timers } = createHarness();
  await mirror.syncOtWarmMirrorController();
  assert.equal(mirror.getCurrentOtStatus(), 'observing');
  assert.equal(timers.size, 1);
  await mirror.pauseOtWarmMirror('running');
  assert.equal(timers.size, 0);
});

test('request-only default ignores restored OT opt-in and schedules no idle sync', async () => {
  const requests = [];
  const h = createHarness({
    backgroundSyncEnabled: undefined,
    syncCustomInstructionsEditorForProject() {},
    mirrorHealth: { shouldStartPrefetch: () => ({ ok: true }) },
    sendBackgroundNative: async request => { requests.push(request.method); throw new Error('Unexpected idle sync'); }
  });
  // Simulate startup, opening the panel, composing a prompt, and settlement.
  await h.mirror.syncOtWarmMirrorController();
  h.mirror.scheduleMirrorPrefetch({ reason: 'cold-start', delayMs: 2500 });
  h.mirror.scheduleMirrorPrefetch({ reason: 'composer-input', delayMs: 1200 });
  await h.mirror.resumeOtWarmMirror('run-settled');
  h.setContent('Edited while Codex is idle');
  assert.equal(h.mirror.isExperimentalOtEnabled(), false);
  assert.equal(h.listeners.has('input'), false);
  assert.equal(h.observer.getStatus().running, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(requests, []);
  h.setProject('second');
  await h.mirror.syncOtWarmMirrorController();
  assert.equal(h.listeners.has('input'), false);
  assert.equal(h.timers.size, 0);
});

test('request-only send bypasses recent mirrors and requires a fresh snapshot', async () => {
  const h = createHarness({
    backgroundSyncEnabled: undefined,
    getMirrorFreshness() { throw new Error('Must not trust a mirror TTL'); },
    callPageBridge() { throw new Error('The run owns the fresh full snapshot'); }
  });
  for (const mode of ['ask', 'edit']) {
    const result = await h.mirror.resolveWarmRunStart({ mode, focusFiles: ['main.tex'] });
    assert.equal(result.useExistingMirror, false);
    assert.equal(result.reason, 'sync_on_request');
  }
});

test('an unavailable editor read cannot become an empty-file OT deletion', () => {
  const { observer, listeners, setContent } = createHarness();
  observer.start();
  setContent(undefined);
  listeners.get('input')();
  assert.equal(observer.getStatus().state, 'unavailable');
  assert.equal(observer.drainEvents().length, 0);
});

test('known empty editor text remains a valid observed edit', () => {
  const { observer, listeners, setContent } = createHarness();
  observer.start();
  setContent('');
  listeners.get('input')();
  assert.equal(observer.getStatus().state, 'observing');
  assert.equal(observer.drainEvents()[0].nextContent, '');
});

test('old OT freshness cannot authorize warm reuse indefinitely', () => {
  const result = Controller.canUseOtWarmStart({ enabled: true, focusFiles: ['main.tex'],
    mirrorStatus: { exists: true, otFreshFiles: [{ path: 'main.tex', state: 'fresh', lastPatchAt: '2000-01-01T00:00:00.000Z' }] }
  });
  assert.equal(result.ok, false);
});

test('focused OT warm reuse verifies current content and carries fresh overlays', async () => {
  let snapshots = 0;
  const { mirror } = createHarness({
    getMirrorFreshness: async () => ({ exists: true, otFreshFiles: [{ path: 'main.tex', state: 'fresh', lastPatchAt: new Date().toISOString() }] }),
    mirrorHealth: { classifyMirrorHealth: () => ({ reusable: false }) },
    callPageBridge: async method => {
      assert.equal(method, 'getProjectSnapshot');
      snapshots += 1;
      return { files: [{ path: 'main.tex', content: 'new collaborator content' }] };
    },
    buildSnapshotFileOverlays: project => project.files,
    normalizeSnapshotPath: value => value
  });
  const result = await mirror.resolveWarmRunStart({ focusFiles: ['main.tex'], mode: 'ask' });
  assert.equal(snapshots, 1);
  assert.equal(result.otWarmStart, true);
  assert.equal(result.fileOverlays[0].content, 'new collaborator content');
});

test('real page events reach the Native mirror in order without claiming a full sync', async t => {
  const { handleRequest } = require('../native-host/src/taskRunner');
  const { getMirrorStatus, getProjectMirror } = require('../native-host/src/mirrorWorkspace');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-ot-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: root };
  await handleRequest({ id: 'baseline', method: 'mirror.sync', params: { projectId: 'example', project: {
    capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'Original text' }]
  } } }, env);
  const before = getMirrorStatus('example', { rootDir: root });
  const requests = [];
  const fixture = createHarness({ sendBackgroundNative: async request => {
    requests.push(request.method);
    return handleRequest({ id: 'ot-patch', ...request }, env);
  } });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('First edit'); fixture.listeners.get('input')();
  fixture.setContent('Second edit'); fixture.listeners.get('input')();
  await fixture.runTimer(0);
  await fixture.runTimer(500);
  const after = getMirrorStatus('example', { rootDir: root });
  const mirror = getProjectMirror('example', { rootDir: root });
  assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'Second edit');
  assert.deepEqual(requests, ['mirror.patchFiles']);
  assert.equal(after.lastFullSyncAt, before.lastFullSyncAt);
  assert.equal(after.otFreshFileCount, 1);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'observing');
  await fixture.mirror.pauseOtWarmMirror('running');
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.listeners.has('input'), false);
});

test('an old project patch result cannot overwrite the next project status', async () => {
  let finish;
  const fixture = createHarness({ sendBackgroundNative: () => new Promise(resolve => { finish = resolve; }) });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('first project edit'); fixture.listeners.get('input')();
  await fixture.runTimer(0); await fixture.runTimer(500);
  assert.equal(typeof finish, 'function');
  fixture.setProject('second');
  await fixture.mirror.syncOtWarmMirrorController();
  finish({ ok: false, error: { code: 'project_locked' } });
  await new Promise(setImmediate);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'observing');
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastErrorCode, '');
});

test('paused or disabled observation cannot continue polling', async () => {
  const fixture = createHarness();
  fixture.setBusy(true);
  await fixture.mirror.syncOtWarmMirrorController();
  assert.equal(fixture.timers.size, 0);
  fixture.setBusy(false);
  await fixture.mirror.resumeOtWarmMirror();
  assert.equal(fixture.timers.size, 1);
  fixture.mirror.setExperimentalOtEnabledForProject('example', false);
  await fixture.mirror.syncOtWarmMirrorController();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'off');
});

test('continuous input is coalesced before expensive hash and diff normalization', () => {
  const otText = require('../extension/src/shared/otText');
  let normalized = 0;
  const fixture = createHarness({ observerOptions: { otText: { ...otText,
    normalizeObservedTextEvent(value) { normalized += 1; return otText.normalizeObservedTextEvent(value); }
  } } });
  fixture.observer.start();
  for (let i = 1; i <= 200; i += 1) {
    fixture.setContent('Original text' + 'x'.repeat(i));
    fixture.listeners.get('input')();
  }
  assert.equal(normalized, 0);
  assert.equal(fixture.observer.getStatus().queuedEventCount, 1);
  const events = fixture.observer.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].baseHash, otText.hashText('Original text'));
  assert.equal(events[0].nextContent, 'Original text' + 'x'.repeat(200));
  assert.equal(normalized, 1);
});

test('observation limits stop oversized files without retaining their content', () => {
  const fixture = createHarness();
  fixture.setContent('x'.repeat(1024 * 1024 + 1));
  const status = fixture.observer.start();
  assert.equal(status.running, false);
  assert.equal(status.lastErrorCode, 'ot_file_limit');
  assert.equal(status.queuedEventCount, 0);
  assert.equal(status.baselineByteCount, 0);
});

test('cross-file event pressure remains bounded and falls back instead of dropping silently', () => {
  const fixture = createHarness();
  fixture.observer.start();
  for (let i = 0; i < 65; i += 1) {
    fixture.setActivePath('section-' + i + '.tex');
    fixture.setContent('before'); fixture.listeners.get('focusin')();
    fixture.setContent('PRIVATE_TEST_TEXT'); fixture.listeners.get('input')();
  }
  const status = fixture.observer.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastErrorCode, 'ot_queue_limit');
  assert.equal(status.queuedEventCount, 0);
  assert.equal(status.queuedTextBytes, 0);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_TEST_TEXT'));
});

test('observed file identity preserves internal whitespace', () => {
  const fixture = createHarness();
  fixture.setActivePath('sections/my  draft.tex');
  fixture.observer.start();
  fixture.setContent('updated'); fixture.listeners.get('input')();
  assert.equal(fixture.observer.drainEvents()[0].path, 'sections/my  draft.tex');
});

test('plugin composer input does not scan the Overleaf editor', () => {
  let reads = 0;
  const fixture = createHarness({ observerOptions: { readActiveEditorText() { reads += 1; return 'unchanged'; } } });
  fixture.observer.start();
  const before = reads;
  fixture.listeners.get('input')({ target: { closest: selector => selector === '#codex-overleaf-panel' ? {} : null } });
  assert.equal(reads, before);
});

test('failed startup stops the page observer and retains a metadata-only failure', async () => {
  const fixture = createHarness();
  fixture.setContent(undefined);
  await fixture.mirror.syncOtWarmMirrorController();
  assert.equal(fixture.observer.getStatus().running, false);
  assert.equal(fixture.listeners.has('input'), false);
  assert.equal(fixture.mirror.isExperimentalOtEnabled(), false);
  assert.equal(fixture.mirror.getOtWarmMirrorState().failureActive, true);
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastFailure.code, 'missing_editor_content');
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastFailure.phase, 'start');
});

test('bridge failure details cannot retain source text in OT diagnostic state', async () => {
  const fixture = createHarness({ callPageBridge: async () => ({ ok: false,
    error: 'Page bridge unavailable: PRIVATE_PROJECT_TEXT' }) });
  await fixture.mirror.syncOtWarmMirrorController();
  const state = fixture.mirror.getOtWarmMirrorState();
  assert.equal(state.lastFailure.code, 'ot_bridge_unavailable');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_PROJECT_TEXT'));
});

test('slow Native responses keep one continuous pending change per adjacent file', async () => {
  const otText = require('../extension/src/shared/otText');
  let finish;
  const calls = [];
  const fixture = createHarness({ sendBackgroundNative: request => {
    calls.push(request);
    if (calls.length === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve({ ok: true, result: { skippedCount: 0, appliedCount: request.params.files.length,
      appliedFiles: request.params.files.map(file => ({ path: file.path, hash: otText.hashText(file.nextContent) })) } });
  } });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('edit 1'); fixture.listeners.get('input')();
  await fixture.runTimer(0); await fixture.runTimer(500);
  for (let i = 2; i <= 21; i += 1) {
    fixture.setContent('edit ' + i); fixture.listeners.get('input')();
    await fixture.runTimer(1000);
  }
  assert.equal(fixture.mirror.getOtWarmMirrorState().patchQueue.length, 1);
  finish({ ok: true, result: { skippedCount: 0, appliedCount: 1,
    appliedFiles: [{ path: 'main.tex', hash: otText.hashText('edit 1') }] } });
  await new Promise(setImmediate);
  await fixture.runTimer(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.files[0].baseHash, otText.hashText('edit 1'));
  assert.equal(calls[1].params.files[0].nextContent, 'edit 21');
  await fixture.mirror.pauseOtWarmMirror();
});

test('partial Native receipts cannot report the whole OT batch as live', async () => {
  const fixture = createHarness({ sendBackgroundNative: async () => ({ ok: true, result: {
    appliedCount: 1, appliedFiles: [{ path: 'main.tex' }], skippedCount: 0, skippedFiles: []
  } }) });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('updated main'); fixture.listeners.get('input')();
  fixture.setActivePath('example/test.tex'); fixture.setContent('nested baseline'); fixture.listeners.get('focusin')();
  fixture.setContent('nested update'); fixture.listeners.get('input')();
  await fixture.runTimer(0); await fixture.runTimer(500);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'inconsistent');
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastErrorCode, 'mirror_patch_invalid_result');
  await fixture.mirror.pauseOtWarmMirror();
});

test('a rejected startup RPC is retained and cleanup is still attempted', async () => {
  const calls = [];
  const fixture = createHarness({ callPageBridge: async method => {
    calls.push(method);
    if (method === 'startOtObserver') throw new Error('Page bridge unavailable: PRIVATE_SOURCE');
    return { ok: true, state: 'off' };
  } });
  await fixture.mirror.syncOtWarmMirrorController();
  assert.deepEqual(calls, ['startOtObserver', 'stopOtObserver']);
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastFailure.code, 'ot_bridge_unavailable');
});

test('Native backlog overflow clears pending text and suspends observation', async () => {
  let finish;
  const fixture = createHarness({ sendBackgroundNative: () => new Promise(resolve => { finish = resolve; }) });
  await fixture.mirror.syncOtWarmMirrorController();
  fixture.setContent('in flight'); fixture.listeners.get('input')();
  await fixture.runTimer(0); await fixture.runTimer(500);
  for (let i = 0; i < 65; i += 1) {
    fixture.setActivePath('folder/file-' + i + '.tex');
    fixture.setContent('base'); fixture.listeners.get('focusin')();
    fixture.setContent('edited'); fixture.listeners.get('input')();
    await fixture.runTimer(1000);
  }
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastFailure.code, 'ot_queue_limit');
  assert.equal(fixture.mirror.getOtWarmMirrorState().patchQueue.length, 0);
  assert.equal(fixture.observer.getStatus().running, false);
  assert.equal(fixture.timers.size, 0);
  finish({ ok: false, error: { code: 'project_locked' } });
  await new Promise(setImmediate);
  assert.equal(fixture.mirror.getOtWarmMirrorState().lastFailure.code, 'ot_queue_limit');
});

test('replacing an observer releases the previous listener and cached baseline', () => {
  const fixture = createHarness();
  fixture.observer.start();
  const replacement = Observer.create({ document: fixture.document, window: fixture.window,
    getActiveFilePath: () => 'main.tex', readActiveEditorText: () => 'replacement baseline' });
  replacement.start();
  assert.equal(fixture.observer.getStatus().running, false);
  assert.equal(fixture.observer.getStatus().baselineByteCount, 0);
  Observer.dispose(fixture.document);
  assert.equal(replacement.getStatus().running, false);
  assert.equal(fixture.listeners.has('input'), false);
});

test('late failed polls cannot contaminate the next project', async () => {
  let rejectPoll;
  const fixture = createHarness({ callPageBridge: async method => {
    if (method === 'getOtStatus') return new Promise((_resolve, reject) => { rejectPoll = reject; });
    return { ok: true, state: 'observing' };
  } });
  await fixture.mirror.syncOtWarmMirrorController();
  await fixture.runTimer(0);
  fixture.setProject('second');
  await fixture.mirror.syncOtWarmMirrorController();
  rejectPoll(new Error('Page bridge unavailable'));
  await new Promise(setImmediate);
  assert.equal(fixture.mirror.getCurrentOtStatus(), 'observing');
  assert.equal(fixture.mirror.getOtWarmMirrorState().failureActive, false);
  await fixture.mirror.pauseOtWarmMirror();
});

test('a delayed Native patch cannot refresh the original observation timestamp', async t => {
  const { syncOverleafToMirror, patchMirrorFiles, getMirrorStatus } = require('../native-host/src/mirrorWorkspace');
  const Text = require('../extension/src/shared/otText');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-ot-observation-time-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await syncOverleafToMirror({ projectId: 'observation-time', rootDir: root, project: {
    files: [{ path: 'main.tex', content: 'base' }], capabilities: { fullProjectSnapshot: true }
  } });
  await patchMirrorFiles({ projectId: 'observation-time', rootDir: root, source: 'ot', files: [{
    path: 'main.tex', baseHash: Text.hashText('base'), nextContent: 'old observed edit',
    observedAt: '2000-01-01T00:00:00.000Z'
  }] });
  const status = getMirrorStatus('observation-time', { rootDir: root });
  assert.equal(status.otFreshFileCount, 0);
  assert.equal(Controller.canUseOtWarmStart({ enabled: true, focusFiles: ['main.tex'], mirrorStatus: status }).ok, false);
});
