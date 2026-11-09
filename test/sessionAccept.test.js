const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractFunction } = require('./_helpers/extractFunction');
const extension = process.env.CODEX_OVERLEAF_TEST_EXTENSION_ROOT || path.resolve(__dirname, '../extension');
const Settlement = require(path.join(extension, 'src/shared/writebackSettlement'));
const { buildExpectedFilesAfterOperations } = require(path.join(extension, 'src/shared/undoOperations'));
const runtime = fs.readFileSync(path.join(extension, 'src/content/contentRuntime.js'), 'utf8');

function run(id, before, after, file = 'main.tex', extra = {}) {
  return {
    id, runProjectId: 'project', trackedChangeStatus: 'pending',
    undoTrackedChanges: [{ path: file, id, key: `change:${id}` }],
    undoExpectedFiles: [{ path: file, content: before }],
    appliedOperations: [{ type: 'edit', path: file, verifiedContent: after,
      patches: [{ from: 0, to: before.length, expected: before, insert: after }] }],
    ...extra
  };
}
function postFiles(run) {
  return Array.from(buildExpectedFilesAfterOperations({ files: run.undoExpectedFiles }, run.appliedOperations),
    ([path, content]) => ({ path, content }));
}
function harness(sessions, options = {}) {
  const state = { sessions, activeSessionId: sessions[0].id, runs: sessions[0].runs };
  const calls = [], events = [], refreshes = [], saved = [];
  const locks = new Map();
  const deps = {
    state, WritebackSettlement: Settlement, buildTrackedUndoPostFiles: postFiles,
    trackedChangeInFlight: locks,
    refreshRunCardControls: id => refreshes.push(id),
    appendRunRecordEvent: (id, event) => events.push({ id, event }),
    tr: key => key, formatTrackedChangeFiles: refs => refs.map(ref => ref.path).join(', '),
    getRunProjectIdForWriteback: run => run.runProjectId,
    callPageBridge: async (method, params) => {
      calls.push({ method, params });
      if (options.bridge) return options.bridge(method, params);
      return { ok: true, verified: true, applied: params.trackedChanges.map(trackedChange => ({
        trackedChange, result: { ok: true, verified: true }
      })), skipped: [] };
    },
    appendAcceptDiagnosticEvents() {}, formatBridgeResultReason: result => result?.code,
    buildContentFailure: Settlement.buildContentFailure,
    findRunRecord: id => sessions.flatMap(session => session.runs).find(run => run.id === id),
    FailureReasons: undefined, saveStateSoon() { saved.push(true); },
    Modules: { ScopedPersistenceCoordinator: require(path.join(extension, 'src/content/scopedPersistencePanelState')) },
    flushQueuedSaveState: async options => { saved.push(structuredClone(state)); }
  };
  const actions = Function(...Object.keys(deps), `
    ${extractFunction(runtime, 'applyTrackedChangeSettlement')}
    ${extractFunction(runtime, 'acceptRun')}
    return { acceptRun };
  `)(...Object.values(deps));
  return { ...actions, state, calls, locks, saved, events, refreshes };
}

test('successive edits use the oldest baseline and latest content, including previous files', () => {
  const first = run('first', 'A', 'AB');
  const otherFile = run('other', 'X', 'XY', 'other.tex');
  const latest = run('latest', 'AB', 'ABC');
  const originals = structuredClone([first, otherFile, latest]);
  const batch = Settlement.buildSessionAcceptBatch([first, otherFile, latest], 'latest', postFiles);
  assert.deepEqual(batch.runs.map(run => run.id), ['first', 'other', 'latest']);
  assert.deepEqual(batch.run.undoExpectedFiles, [{ path: 'main.tex', content: 'A' }, { path: 'other.tex', content: 'X' }]);
  assert.deepEqual(batch.postFiles, [{ path: 'main.tex', content: 'ABC' }, { path: 'other.tex', content: 'XY' }]);
  assert.deepEqual(batch.run.appliedOperations, []);
  assert.deepEqual([first, otherFile, latest], originals);
});

test('accept excludes resolved, undone, forked, foreign-project, and later requests', () => {
  const pending = run('pending', 'A', 'B', 'main.tex', { trackedChangeStatus: 'needs_review' });
  const latest = run('latest', 'B', 'C');
  const runs = [
    run('accepted', 'A', 'B', 'a.tex', { trackedChangeStatus: 'accepted' }),
    run('rejected', 'A', 'B', 'b.tex', { trackedChangeStatus: 'rejected' }),
    run('undone', 'A', 'B', 'c.tex', { undoStatus: 'applied' }),
    run('fork', 'A', 'B', 'd.tex', { forkSnapshot: true }),
    run('foreign', 'A', 'B', 'e.tex', { runProjectId: 'other-project' }),
    pending, { id: 'ask', mode: 'ask' }, latest, run('later', 'C', 'D')
  ];
  assert.deepEqual(Settlement.buildSessionAcceptBatch(runs, latest.id, postFiles).runs, [pending, latest]);
  assert.equal(Settlement.buildSessionAcceptBatch(runs, 'accepted', postFiles), null);
  assert.equal(Settlement.buildSessionAcceptBatch(runs, 'missing', postFiles), null);
});

test('single-run accept preserves its original targeted operations and deduplicates refs', () => {
  const only = run('only', 'A', 'B');
  only.undoTrackedChanges.push({ ...only.undoTrackedChanges[0] });
  const batch = Settlement.buildSessionAcceptBatch([only], 'only', postFiles);
  assert.deepEqual(batch.run.appliedOperations, only.appliedOperations);
  assert.equal(batch.run.undoTrackedChanges.length, 1);
});

test('one Accept dispatch includes all pending predecessors and persists all accepted statuses', async () => {
  const first = run('first', 'A', 'AB');
  const latest = run('latest', 'AB', 'ABC');
  const otherSession = run('other-session', 'X', 'Y');
  const h = harness([{ id: 's1', runs: [first, latest] }, { id: 's2', runs: [otherSession] }]);
  await h.acceptRun(latest.id);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'acceptTrackedChanges');
  assert.deepEqual(h.calls[0].params.trackedChanges.map(ref => ref.id), ['first', 'latest']);
  assert.deepEqual(h.calls[0].params.postFiles, [{ path: 'main.tex', content: 'ABC' }]);
  for (const target of [first, latest]) {
    assert.equal(target.trackedChangeStatus, 'accepted');
    assert.deepEqual(target.undoTrackedChanges, []);
    assert.deepEqual(target.undoExpectedFiles, []);
    assert.ok(h.refreshes.includes(target.id));
  }
  assert.ok(h.saved.length);
  assert.equal(otherSession.trackedChangeStatus, 'pending');
  assert.equal(h.locks.size, 0);
  await h.acceptRun(latest.id);
  assert.equal(h.calls.length, 1);
});

test('accepting an inactive session uses only that session and its predecessors', async () => {
  const active = run('active', 'X', 'Y');
  const first = run('first', 'A', 'B');
  const last = run('last', 'B', 'C');
  const h = harness([{ id: 'active', runs: [active] }, { id: 'inactive', runs: [first, last] }]);
  await h.acceptRun(last.id);
  assert.deepEqual(h.calls[0].params.trackedChanges.map(ref => ref.id), ['first', 'last']);
  assert.equal(active.trackedChangeStatus, 'pending');
});

test('a concurrent Accept cannot dispatch an overlapping batch and locks last until settlement', async () => {
  let resolveBridge;
  const first = run('first', 'A', 'B'), last = run('last', 'B', 'C');
  const h = harness([{ id: 's', runs: [first, last] }], {
    bridge: () => new Promise(resolve => { resolveBridge = resolve; })
  });
  const pending = h.acceptRun(last.id);
  assert.deepEqual([...h.locks.keys()], ['first', 'last']);
  await h.acceptRun(first.id);
  assert.equal(h.calls.length, 1);
  resolveBridge({ ok: true, verified: true, applied: [], skipped: [] });
  await pending;
  assert.equal(h.locks.size, 0);
});

test('partial batch acceptance keeps every checkpoint actionable for retry', async () => {
  const first = run('first', 'A', 'B'), last = run('last', 'B', 'C');
  const h = harness([{ id: 's', runs: [first, last] }], { bridge: async () => ({
    ok: false,
    applied: [{ trackedChange: first.undoTrackedChanges[0], result: { ok: true } }],
    skipped: [{ trackedChange: last.undoTrackedChanges[0], result: { ok: false, code: 'accept_not_verified' } }]
  }) });
  await h.acceptRun(last.id);
  for (const target of [first, last]) {
    assert.equal(target.trackedChangeStatus, 'needs_review');
    assert.equal(target.undoTrackedChanges.length, 1);
    assert.equal(target.undoExpectedFiles.length, 1);
  }
});

test('bridge exceptions release every batch lock and preserve pending changes', async () => {
  const first = run('first', 'A', 'B'), last = run('last', 'B', 'C');
  const h = harness([{ id: 's', runs: [first, last] }], { bridge: async () => { throw new Error('disconnected'); } });
  await assert.rejects(h.acceptRun(last.id), /disconnected/);
  assert.equal(h.locks.size, 0);
  assert.equal(first.trackedChangeStatus, 'pending');
  assert.equal(last.trackedChangeStatus, 'pending');
});

const capturePath = path.join(extension, 'src/page/trackedChangeCapture.js');
test('native acceptance sends both runs IDs and preserves unrelated review changes and text', {
  skip: !fs.existsSync(capturePath)
}, async () => {
  const Lifecycle = require(path.join(extension, 'src/page/trackedChangesLifecycle'));
  const captureSource = fs.readFileSync(capturePath, 'utf8');
  const nativeRef = id => ({ id, path: 'main.tex', kind: 'insert', textHash: `hash-${id}`,
    key: `native:${JSON.stringify([id, 'insert', 0, 1, `hash-${id}`])}` });
  const first = run('first', 'A', 'AB'), last = run('last', 'AB', 'ABC');
  first.undoTrackedChanges = [nativeRef('first')];
  last.undoTrackedChanges = [nativeRef('last')];
  let ledger = [nativeRef('first'), nativeRef('last'), nativeRef('unrelated')];
  const snapshot = () => ({ ready: true, source: 'native', nativeDocId: 'doc',
    acceptByIdSupported: true, refs: ledger });
  const prepare = Function('readNativeSnapshot', `${extractFunction(captureSource, 'prepareTrackedChangeReview')}; return prepareTrackedChangeReview;`)(snapshot);
  const requests = [];
  const page = Lifecycle.create({
    window: {
      document: { querySelector: () => ({ getAttribute: () => 'test-csrf' }) },
      AbortController, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        const ids = JSON.parse(options.body).change_ids;
        requests.push({ url, ids });
        ledger = ledger.filter(ref => !ids.includes(ref.id));
        return { ok: true };
      },
      CodexOverleafTrackedChangeCapture: { create: () => ({
        prepareTrackedChangeReview: prepare, prepareTrackedChangeCapture: snapshot
      }) }
    },
    getCodeMirrorEditorView: () => ({}),
    checkWritebackRunProjectId: params => params.runProjectId === 'project' ? null : { ok: false },
    normalizeTrackedChangeRefs: Settlement.normalizeApplyTrackedChanges,
    normalizeSafeProjectPath: value => value,
    getActiveFilePath: () => 'main.tex', readActiveEditorText: () => 'ABC',
    delay: async () => {},
    buildPageFailure: () => ({ code: 'tracked_changes_remain' }),
    applyOperationsCore: () => assert.fail('native accept must preserve document text')
  });
  const h = harness([{ id: 's', runs: [first, last] }], {
    bridge: (method, params) => page[method](params)
  });
  await h.acceptRun(last.id);
  assert.deepEqual(requests, [{ url: '/project/project/doc/doc/changes/accept', ids: ['first', 'last'] }]);
  assert.deepEqual(ledger.map(ref => ref.id), ['unrelated']);
  assert.equal(first.trackedChangeStatus, 'accepted');
  assert.equal(last.trackedChangeStatus, 'accepted');
});
