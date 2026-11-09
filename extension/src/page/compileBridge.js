(function initCompileBridge(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafCompileBridge = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function compileBridgeFactory() {
  'use strict';

  const COMPILE_TEMPLATE_TTL_MS = 5 * 60 * 1000;
  const GLOBAL_STATE_KEY = '__codexOverleafCompileBridgeState';

  function create(deps = {}) {
    const pageWindow = deps.window || window;
    const pageDocument = deps.document || document;
    let installed = false;
    const state = pageWindow[GLOBAL_STATE_KEY] || {
      capturedRequestTemplate: null,
      lastCompileResponse: null,
      lastCompileAt: 0,
      lastCompileSourceChangeTimestamp: 0,
      lastKnownSourceEditTimestamp: 0,
      originalFetch: null,
      wrappedFetch: null,
      inputListenerInstalled: false
    };
    pageWindow[GLOBAL_STATE_KEY] = state;

    function install() {
      if (installed) {
        return;
      }
      installed = true;
      interceptCompileRequests();
      if (typeof pageDocument.addEventListener === 'function' && state.inputListenerInstalled !== true) {
        pageDocument.addEventListener('input', markSourceEditFromInput, true);
        state.inputListenerInstalled = true;
      }
    }

    function interceptCompileRequests() {
      if (state.wrappedFetch && pageWindow.fetch === state.wrappedFetch) {
        return;
      }
      if (!state.originalFetch || pageWindow.fetch !== state.wrappedFetch) {
        state.originalFetch = pageWindow.fetch;
      }
      const originalFetch = state.originalFetch;
      state.wrappedFetch = async function codexOverleafCompileFetchWrapper(...args) {
        const [resource, init] = args;
        const url = typeof resource === 'string' ? resource : (resource?.url || '');
        const method = (init?.method || 'GET').toUpperCase();
        const isCompileRequest = /\/project\/[^/]+\/compile\b/.test(url) && method === 'POST';
        const compileSourceChangeTimestamp = isCompileRequest ? state.lastKnownSourceEditTimestamp : 0;

        if (isCompileRequest) {
          state.capturedRequestTemplate = {
            url,
            method: 'POST',
            capturedAt: Date.now(),
            headers: init?.headers ? (
              init.headers instanceof Headers
                ? Object.fromEntries(init.headers.entries())
                : { ...init.headers }
            ) : {},
            body: init?.body || null
          };
        }

        const response = await originalFetch.apply(this, args);

        if (isCompileRequest && response.ok) {
          try {
            const clone = response.clone();
            const json = await clone.json();
            const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
            if (CompileAdapter) {
              state.lastCompileResponse = CompileAdapter.parseCompileResponse(json);
              state.lastCompileAt = Date.now();
              state.lastCompileSourceChangeTimestamp = compileSourceChangeTimestamp;
            }
          } catch (_e) { /* ignore parse errors */ }
        }

        return response;
      };
      pageWindow.fetch = state.wrappedFetch;
    }

    async function triggerCompile(params = {}) {
      const saveResult = await waitForCompileSaveState(params);
      if (params.requireVerifiedSave !== false && saveResult.state !== 'verified_saved') {
        return {
          ok: false,
          reason: saveResult.reason || 'Overleaf save state was not verified.',
          saveStateVerified: false,
          saveState: saveResult.state || 'unknown_timeout'
        };
      }
      const saveMetadata = buildSaveStateMetadata(saveResult);
      const sourceChangeTimestamp = state.lastKnownSourceEditTimestamp;
      if (params.preferUiClick === true) {
        const clicked = clickOverleafCompileButton();
        if (clicked) {
          const captured = await waitForCapturedCompile(params.captureTimeoutMs || 60000);
          if (captured.ok) {
            return {
              ok: true,
              compile: state.lastCompileResponse,
              ...saveMetadata,
              triggeredBy: 'overleaf-button'
            };
          }
          return {
            ok: true,
            compile: { ok: true, status: 'triggered' },
            resultCaptured: false,
            reason: captured.reason,
            ...saveMetadata,
            triggeredBy: 'overleaf-button'
          };
        }
      }
      const template = state.capturedRequestTemplate;
      if (!template) {
        const clicked = clickOverleafCompileButton();
        if (!clicked) {
          return {
            ok: false,
            reason: 'No Overleaf Recompile button or compile request template is available.',
            ...saveMetadata
          };
        }
        const captured = await waitForCapturedCompile(params.captureTimeoutMs || 60000);
        if (!captured.ok) {
          return {
            ...captured,
            ...saveMetadata
          };
        }
        return {
          ok: true,
          compile: state.lastCompileResponse,
          ...saveMetadata,
          triggeredBy: 'overleaf-button'
        };
      }
      if (!isFreshCapturedRequestTemplate(template)) {
        const clicked = clickOverleafCompileButton();
        if (!clicked) {
          return {
            ok: false,
            reason: 'Stored compile request template expired. Please click Overleaf Recompile once, then retry.',
            ...saveMetadata
          };
        }
        const captured = await waitForCapturedCompile(params.captureTimeoutMs || 60000);
        if (!captured.ok) {
          return {
            ...captured,
            ...saveMetadata
          };
        }
        return {
          ok: true,
          compile: state.lastCompileResponse,
          ...saveMetadata,
          triggeredBy: 'overleaf-button'
        };
      }

      try {
        const response = await pageWindow.fetch(template.url, {
          method: template.method,
          headers: template.headers,
          body: template.body,
          credentials: 'same-origin'
        });
        if (!response.ok) {
          return {
            ok: false,
            reason: `Compile request failed with status ${response.status}`,
            ...saveMetadata
          };
        }
        const json = await response.json();
        const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
        const parsed = CompileAdapter
          ? CompileAdapter.parseCompileResponse(json)
          : { ok: false, reason: 'CompileAdapter not available' };
        state.lastCompileResponse = parsed;
        state.lastCompileAt = Date.now();
        state.lastCompileSourceChangeTimestamp = sourceChangeTimestamp;
        return {
          ok: true,
          compile: parsed,
          ...saveMetadata
        };
      } catch (error) {
        return {
          ok: false,
          reason: `Compile request error: ${error.message}`,
          ...saveMetadata
        };
      }
    }

    async function waitForCompileSaveState(params = {}) {
      if (typeof deps.waitForSaveState !== 'function') {
        return {
          ok: false,
          state: 'unavailable',
          reason: 'Overleaf save-state checker is unavailable.'
        };
      }
      try {
        return normalizeSaveStateResult(
          await deps.waitForSaveState({ deadlineMs: resolveWaitForSaveMs(params.waitForSaveMs) })
        );
      } catch (error) {
        return {
          ok: false,
          state: 'unavailable',
          reason: `Overleaf save-state checker failed: ${error.message}`
        };
      }
    }

    function resolveWaitForSaveMs(value) {
      if (value == null) {
        return 5000;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 5000;
    }

    function normalizeSaveStateResult(result = {}) {
      if (result.ok === true && !result.state) {
        return {
          ...result,
          state: 'verified_saved'
        };
      }
      if (result.state === 'verified_saved') {
        return {
          ...result,
          ok: true,
          state: 'verified_saved'
        };
      }
      return {
        ...result,
        ok: false,
        state: result.state || 'unknown_timeout'
      };
    }

    function buildSaveStateMetadata(saveResult = {}) {
      const saveState = saveResult.state || 'unknown_timeout';
      return {
        saveStateVerified: saveState === 'verified_saved',
        saveState
      };
    }

    async function getCompileLog(params = {}) {
      const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
      if (!CompileAdapter) {
        return { ok: false, reason: 'CompileAdapter not loaded' };
      }

      const maxAgeMs = params.maxAgeMs || 30000;
      const compileLogFresh = CompileAdapter.isCompileLogFresh(
        { sourceChangeTimestamp: state.lastCompileSourceChangeTimestamp },
        state.lastKnownSourceEditTimestamp
      );
      const needsFreshCompile = !state.lastCompileResponse?.ok
        || (Date.now() - state.lastCompileAt > maxAgeMs)
        || !compileLogFresh;

      if (needsFreshCompile && params.triggerIfStale !== false) {
        const compileResult = await triggerCompile({ waitForSaveMs: resolveWaitForSaveMs(params.waitForSaveMs) });
        if (!compileResult.ok) {
          return {
            ok: false,
            reason: `Could not get fresh compile: ${compileResult.reason}`,
            saveStateVerified: compileResult.saveStateVerified,
            saveState: compileResult.saveState
          };
        }
      }

      const compiled = state.lastCompileResponse;
      if (!compiled?.ok || !compiled.logUrl) {
        return { ok: false, reason: 'No compile log URL available' };
      }

      try {
        const logUrl = compiled.logUrl.startsWith('/')
          ? `${pageWindow.location.origin}${compiled.logUrl}`
          : compiled.logUrl;
        const response = await pageWindow.fetch(logUrl, { credentials: 'same-origin' });
        if (!response.ok) {
          return { ok: false, reason: `Failed to fetch compile log: ${response.status}` };
        }
        const logContent = await response.text();
        const truncated = CompileAdapter.truncateLogForContext(logContent);
        const parsed = CompileAdapter.parseLogErrors(logContent);
        return {
          ok: true,
          log: truncated,
          errors: parsed.errors,
          warnings: parsed.warnings,
          compiledAt: state.lastCompileAt,
          fresh: CompileAdapter.isCompileLogFresh(
            { sourceChangeTimestamp: state.lastCompileSourceChangeTimestamp },
            state.lastKnownSourceEditTimestamp
          )
        };
      } catch (error) {
        return { ok: false, reason: `Log fetch error: ${error.message}` };
      }
    }

    function getCompileState() {
      return {
        ok: true,
        hasCapturedTemplate: Boolean(state.capturedRequestTemplate),
        capturedTemplateAgeMs: state.capturedRequestTemplate?.capturedAt
          ? Date.now() - state.capturedRequestTemplate.capturedAt
          : null,
        lastCompileAt: state.lastCompileAt,
        lastCompileOk: state.lastCompileResponse?.ok || false,
        lastCompileSourceChangeTimestamp: state.lastCompileSourceChangeTimestamp,
        lastKnownSourceEditTimestamp: state.lastKnownSourceEditTimestamp
      };
    }

    function isFreshCapturedRequestTemplate(template) {
      return Boolean(template?.capturedAt && Date.now() - template.capturedAt <= COMPILE_TEMPLATE_TTL_MS);
    }

    function markSourceEdited(timestamp = Date.now()) {
      state.lastKnownSourceEditTimestamp = timestamp;
    }

    function markSourceEditFromInput(event) {
      const target = event.target;
      if (!target || target.closest?.('#codex-overleaf-panel')) {
        return;
      }
      if (!isLikelyEditorInputTarget(target)) {
        return;
      }
      // Conservatively invalidate compile freshness on any source-editor edit.
      // Resolving the current path here traverses the project tree on every
      // keystroke; file identity is only needed when a request reads/writes it.
      markSourceEdited();
    }

    function clickOverleafCompileButton() {
      const candidates = findOverleafCompileButtons();
      for (const candidate of candidates) {
        if (isDisabled(candidate)) {
          continue;
        }
        if (typeof candidate.click === 'function') {
          candidate.click();
          return true;
        }
        if (typeof candidate.dispatchEvent === 'function') {
          const EventCtor = pageWindow.MouseEvent || pageWindow.Event;
          if (EventCtor) {
            candidate.dispatchEvent(new EventCtor('click', { bubbles: true, cancelable: true }));
            return true;
          }
        }
      }
      return false;
    }

    function findOverleafCompileButtons() {
      if (typeof pageDocument.querySelectorAll !== 'function') {
        return [];
      }
      const selectors = [
        'button',
        '[role="button"]',
        '[aria-label*="compile" i]',
        '[title*="compile" i]',
        '[data-testid*="compile" i]'
      ];
      const nodes = [];
      for (const selector of selectors) {
        try {
          nodes.push(...Array.from(pageDocument.querySelectorAll(selector)));
        } catch (_e) { /* ignore unsupported selectors in tests/older browsers */ }
      }
      return uniqueNodes(nodes).filter(isCompileButton);
    }

    function isCompileButton(node) {
      const text = [
        node.textContent,
        node.innerText,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('data-testid')
      ].filter(Boolean).join(' ').toLowerCase();
      return /\b(recompile|compile)\b/.test(text) || /重新编译|编译/.test(text);
    }

    function isDisabled(node) {
      return Boolean(node.disabled
        || node.getAttribute?.('disabled') != null
        || node.getAttribute?.('aria-disabled') === 'true');
    }

    async function waitForCapturedCompile(timeoutMs) {
      const startCompileAt = state.lastCompileAt;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.lastCompileAt > startCompileAt && state.lastCompileResponse) {
          return { ok: true };
        }
        await delay(100);
      }
      return { ok: false, reason: 'Clicked Overleaf Recompile, but no compile result was captured.' };
    }

    return {
      getCompileLog,
      getCompileState,
      install,
      markSourceEdited,
      state,
      triggerCompile
    };
  }

  function isLikelyEditorInputTarget(target) {
    return Boolean(target.matches?.('textarea, [contenteditable="true"], .cm-content, .CodeMirror-code')
      || target.closest?.('.cm-content, .CodeMirror-code, .cm-editor, .CodeMirror'));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function uniqueNodes(nodes) {
    return Array.from(new Set(nodes.filter(Boolean)));
  }

  return {
    COMPILE_TEMPLATE_TTL_MS,
    create,
    isLikelyEditorInputTarget
  };
});
