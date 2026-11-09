const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

// The same behavior checks can also verify a staged/installed runtime.
const extensionRoot = process.env.CODEX_OVERLEAF_TEST_EXTENSION_ROOT
  || path.resolve(__dirname, '../extension');
const read = relative => fs.readFileSync(path.join(extensionRoot, 'src', relative), 'utf8');

test('source typing invalidates compile freshness without reading file identity or content', () => {
  const CompileBridge = require(path.join(extensionRoot, 'src/page/compileBridge'));
  const callbacks = new Map();
  let pathReads = 0;
  const bridge = CompileBridge.create({
    window: { fetch: async () => { throw new Error('Unexpected network'); } },
    document: {
      addEventListener: (name, callback) => callbacks.set(name, callback),
      querySelectorAll() { throw new Error('Input must not scan the DOM'); }
    },
    getActiveFilePath() { pathReads++; throw new Error('Input must not resolve file identity'); }
  });
  bridge.install();
  const input = callbacks.get('input');
  for (let i = 0; i < 100; i++) {
    bridge.state.lastKnownSourceEditTimestamp = 0;
    input({ target: { closest: () => null, matches: () => true } });
    assert.ok(bridge.getCompileState().lastKnownSourceEditTimestamp > 0);
  }
  assert.equal(pathReads, 0);
  bridge.state.lastKnownSourceEditTimestamp = 0;
  input({ target: { closest: () => null, matches: () => false } });
  input({ target: { closest: () => ({}), matches: () => true } });
  assert.equal(bridge.getCompileState().lastKnownSourceEditTimestamp, 0,
    'search/composer inputs must not invalidate a compile');
});

test('restored OT opt-in cannot start polling, prefetch, or warm reuse in production', async () => {
  const requests = [];
  const timers = new Map();
  let id = 0;
  const window = {
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = vm.createContext({ window });
  vm.runInContext(read('content/otWarmMirror.js'), context);
  const mirror = window.CodexOverleafOtWarmMirror.create({
    getState: () => ({ experimentalOtByProject: { project: true } }),
    getCurrentProjectId: () => 'project', getCurrentRunView: () => null,
    getPanel: () => null, tr: key => key, updateProbeStatusOtSuffix() {},
    otWarmMirrorController: require(path.join(extensionRoot, 'src/content/otWarmMirrorController')),
    callPageBridge: async method => { requests.push(method); return { ok: true, state: 'off' }; },
    sendBackgroundNative() { throw new Error('Unexpected background sync'); },
    getMirrorFreshness() { throw new Error('Cannot trust mirror age'); }
  });
  await mirror.syncOtWarmMirrorController();
  mirror.scheduleMirrorPrefetch({ reason: 'cold-start', delayMs: 2500 });
  mirror.scheduleMirrorPrefetch({ reason: 'composer-input', delayMs: 1200 });
  await mirror.resumeOtWarmMirror('run-settled');
  assert.equal(mirror.isExperimentalOtEnabled(), false);
  assert.equal(mirror.getCurrentOtStatus(), 'off');
  assert.equal(timers.size, 0);
  assert.deepEqual(requests, ['stopOtObserver']);
  for (const mode of ['ask', 'edit']) {
    assert.equal((await mirror.resolveWarmRunStart({ mode })).useExistingMirror, false);
  }
});

test('each submitted request reads changed inactive files and deletions from a fresh full snapshot', async () => {
  const Snapshot = require(path.join(extensionRoot, 'src/page/overleafProjectSnapshot'));
  const requests = [];
  let files = [{ path: 'main.tex', content: 'active' }, { path: 'other.tex', content: 'before' }];
  const snapshot = Snapshot.create({
    window: { location: { origin: 'https://www.overleaf.com', pathname: '/project/example' } },
    getProjectId: () => 'example', normalizePath: value => value,
    buildProjectSnapshot: async options => {
      requests.push(options);
      return { files: files.map(file => ({ ...file })), capabilities: { fullProjectSnapshot: true } };
    }
  });
  const runtime = read('content/contentRuntime.js');
  const context = vm.createContext({
    callPageBridge: (method, options) => {
      assert.equal(method, 'getProjectSnapshot');
      return snapshot.getProjectSnapshot(options);
    },
    getActiveFocusFiles: () => ['main.tex'], RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000,
    sanitizeRunProjectSnapshot: value => value
  });
  vm.runInContext(extractFunction(runtime, 'getRunProjectSnapshot'), context);
  assert.equal((await context.getRunProjectSnapshot()).files[1].content, 'before');
  files[1].content = 'edited in another tab';
  assert.equal((await context.getRunProjectSnapshot()).files[1].content, 'edited in another tab');
  files = files.slice(0, 1);
  assert.equal((await context.getRunProjectSnapshot()).files.length, 1);
  assert.equal(requests.length, 3);
  for (const options of requests) {
    assert.equal(options.force, true);
    assert.equal(options.maxAgeMs, 0);
    assert.equal(options.requireFullProject, true);
    assert.equal(options.includeBinaryFiles, true);
    assert.equal(options.allowEditorNavigation, false);
  }
  vm.runInContext(extractFunction(runtime, 'resolveWarmMirrorReuse'), context);
  assert.equal((await context.resolveWarmMirrorReuse()).useExistingMirror, false);
});

test('panel mount and composer input do not schedule project synchronization', () => {
  const runtime = read('content/contentRuntime.js');
  assert.match(runtime, /backgroundSyncEnabled: false/);
  for (const name of ['ensurePanelOpen', 'handleTaskInput']) {
    assert.doesNotMatch(extractFunction(runtime, name), /scheduleMirrorPrefetch\(/);
  }
  assert.doesNotMatch(read('content/settingsPanel.js'), /data-experimental-ot\b/);
});
