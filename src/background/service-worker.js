/**
 * service-worker.js — Colophon background service worker (MV3)
 *
 * Owns session state. Content script and popup talk through here.
 *
 * Message protocol:
 *   Popup  → SW:    SESSION_START { tabId, docUrl }
 *   Popup  → SW:    SESSION_STOP
 *   Popup  → SW:    GET_STATE
 *   Popup  → SW:    EXPORT
 *   Content → SW:   LOG_EVENT { TwffEvent }
 *
 * SW → content:  ACTIVATE / DEACTIVATE (via chrome.tabs.sendMessage)
 */

import {
  getSession,
  saveSession,
  getSessionByDocId,
  saveSessionByDocId,
  ensureSessionUserId,
  generateUserId,
  aggregateOldEditEvents,
} from "../shared/storage.js";
import { ProcessLog } from "../lib/process-log.js";
import { debugLog } from "../shared/debug.js";
import { formatDocTitle } from "../shared/doc-title.js";

// ── Native Messaging (llamafile host) ─────────────────────────────────────────

const NATIVE_HOST = 'com.colophon.llamahost';
let _nativePort = null;
let _modelStatus = 'unknown'; // 'unknown'|'host_not_installed'|'no_model'|'available'|'running'
let _llamafilePort = 8080;
let _lastSelection = { text: '' };
let _lastDocContext = null;
let _lastSnapshotTimestamp = 0;
let _pendingAIOutput = null; // { text, subtype, model, expiresAt } — set when sidepanel sends paraphrase/improve result

function getNativePort() {
  if (_nativePort) return _nativePort;
  try {
    _nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    _nativePort.onMessage.addListener(onNativeMessage);
    _nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      debugLog('[Colophon] Native host disconnected:', err);
      _nativePort = null;
      const notFound = err.toLowerCase().includes('not found') ||
                       err.toLowerCase().includes('specified native') ||
                       err.toLowerCase().includes('cannot find');
      _modelStatus = notFound ? 'host_not_installed' : 'disconnected';
      broadcastModelStatus();
    });
    return _nativePort;
  } catch (e) {
    debugLog('[Colophon] Cannot connect to native host:', e.message);
    _nativePort = null;
    _modelStatus = 'host_not_installed';
    broadcastModelStatus();
    return null;
  }
}

function onNativeMessage(msg) {
  debugLog('[Colophon] Native msg:', msg.action, msg);
  switch (msg.action) {
    case 'MODEL_STATUS':
      _modelStatus = msg.found ? 'available' : 'no_model';
      broadcastModelStatus();
      break;
    case 'PROGRESS':
      chrome.runtime.sendMessage({
        action: 'MODEL_DOWNLOAD_PROGRESS',
        label: msg.label,
        percent: msg.percent,
      }).catch(() => {});
      break;
    case 'DOWNLOAD_DONE':
      // Auto-launch after a successful download
      _nativePort?.postMessage({ action: 'LAUNCH_MODEL' });
      break;
    case 'LAUNCHED':
      _modelStatus = 'running';
      _llamafilePort = msg.port;
      chrome.storage.local.set({ llamafilePort: msg.port }).catch(() => {});
      broadcastModelStatus({ port: msg.port });
      break;
    case 'STOPPED':
      _modelStatus = 'available';
      broadcastModelStatus();
      break;
    case 'ERROR':
      chrome.runtime.sendMessage({
        action: 'MODEL_ERROR',
        message: msg.message,
      }).catch(() => {});
      break;
  }
}

function broadcastModelStatus(extra = {}) {
  chrome.runtime.sendMessage({
    action: 'MODEL_STATUS_UPDATE',
    status: _modelStatus,
    ...extra,
  }).catch(() => {});
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Restore in-memory snapshot timestamp from persisted session metadata on SW
// startup. Kept as an awaitable promise (not fire-and-forget) — a
// GET_SNAPSHOT_AGE message arriving in the brief window right after a cold
// start, before this resolved, used to see _lastSnapshotTimestamp still at
// its initial 0 and answer "Infinity ms since last snapshot" even when a
// real, recent snapshot was already on disk.
const _snapshotRestorePromise = getSession().then(session => {
  const ts = session?.metadata?.last_snapshot_timestamp;
  if (ts) _lastSnapshotTimestamp = ts;
}).catch(() => {});

// Restore in-memory llamafile port from storage on SW startup
chrome.storage.local.get('llamafilePort').then(res => {
  if (res.llamafilePort) {
    _llamafilePort = res.llamafilePort;
  }
}).catch(() => {});

// Restore pending AI output (set by a sidepanel paraphrase/improve quick
// action, consumed by the next matching paste) from storage on SW startup —
// previously in-memory only, so an MV3 idle-termination between the two
// (realistic: the whole point of this flow is the user alt-tabbing out to
// an AI tool and back, which easily outlasts the SW's idle timeout) lost
// it, and a paste that really was that AI's output silently logged as a
// plain, un-self-reported paste instead of an ai_interaction.
chrome.storage.local.get('pendingAIOutput').then(res => {
  if (res.pendingAIOutput && Date.now() < res.pendingAIOutput.expiresAt) {
    _pendingAIOutput = res.pendingAIOutput;
  }
}).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  debugLog("[Colophon] Installed.");
  chrome.contextMenus.create({
    id: 'colophon-paraphrase',
    title: 'Paraphrase with Colophon',
    contexts: ['selection'],
    documentUrlPatterns: ['https://docs.google.com/document/*'],
  });
  chrome.contextMenus.create({
    id: 'colophon-add-source',
    title: 'Add source for this text',
    contexts: ['selection'],
    documentUrlPatterns: ['https://docs.google.com/document/*'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const text = info.selectionText ?? '';
  if (!text) return;

  // chrome.sidePanel is Chrome-only; Firefox uses sidebarAction.
  const sidebar = globalThis.browser?.sidebarAction ?? chrome.sidebarAction;
  if (chrome.sidePanel) {
    await chrome.sidePanel.open({ tabId: tab.id });
  } else if (sidebar?.open) {
    await sidebar.open();
  }

  // Small delay so sidepanel has time to mount before receiving the message
  setTimeout(() => {
    chrome.runtime.sendMessage({
      action: 'CONTEXT_MENU_ACTION',
      payload: { menuId: info.menuItemId, text },
    }).catch(() => {});
  }, 400);
});

// ── Message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Defense-in-depth: not currently exploitable (no externally_connectable,
  // no onMessageExternal in the manifest, so chrome.runtime.onMessage only
  // ever fires for this extension's own pages/content scripts regardless of
  // this check), but cheap insurance against a future manifest change that
  // would make it exploitable. A message truly from this extension always
  // carries sender.id === chrome.runtime.id; one that doesn't is rejected
  // rather than processed.
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'Rejected: sender is not this extension.' });
    return;
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("[Colophon]", err.message);
      sendResponse({ error: err.message });
    });
  return true; // keep port open for async response
});

async function handleMessage(msg, _sender) {
  const route = msg.type || msg.action;

  switch (route) {
    case "SESSION_START":
    case "startSession":
      // Fall back to the sender's tab id when the message doesn't carry one —
      // e.g. the in-page "Start Session" toast can't know its own tabId,
      // unlike the popup which queries it explicitly. Without this, the
      // session gets marked as recording but activateContentScript() is
      // silently skipped, so no events are ever actually captured.
      return startSession({ ...msg, tabId: msg.tabId ?? _sender?.tab?.id }); // Pass the whole msg so we can grab msg.title

    case "AUTO_SESSION_START":
      // Always-on recording (spike): the content script asks to start as soon as
      // a Doc opens, so writing before any button click is still captured. The
      // tab/url come from the message sender (a content script doesn't know its
      // own tabId), and we never clobber a session that's already recording.
      return autoStartSession(_sender);

    case "SESSION_STOP":
    case "endSession":
      return stopSession();

    case "LOG_EVENT":
      return appendEvent(msg.payload, _sender);

    case "GET_STATE":
    case "getSession":
      return getState();

    case "EXPORT":
    case "exportSession":
      return exportSession();

    case 'UPDATE_METADATA':
      return updateMetadata(msg.payload);

    case 'UPDATE_EVENT_STATE': 
      return updateEventState(msg.payload);

    case 'SYNC_TIMELINE':
      return { ok: true, ignored: true };

    case 'CHECK_MODEL_STATUS': {
      try {
        const healthUrl = `http://127.0.0.1:${_llamafilePort}/health`;
        const resp = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          _modelStatus = 'running';
          return { ok: true, status: 'running', port: _llamafilePort };
        }
      } catch {
        if (_modelStatus === 'running') {
          _modelStatus = 'available';
        }
      }
      const port = getNativePort();
      if (port) port.postMessage({ action: 'CHECK_MODEL' });
      return { ok: true, status: _modelStatus, port: _llamafilePort };
    }

    case 'REQUEST_DOWNLOAD_MODEL': {
      const port = getNativePort();
      if (!port) return { ok: false, error: 'Native host not installed' };
      port.postMessage({ action: 'DOWNLOAD_MODEL' });
      return { ok: true };
    }

    case 'REQUEST_LAUNCH_MODEL': {
      const port = getNativePort();
      if (!port) return { ok: false, error: 'Native host not installed' };
      port.postMessage({ action: 'LAUNCH_MODEL' });
      return { ok: true };
    }

    case 'REQUEST_STOP_MODEL': {
      if (_nativePort) _nativePort.postMessage({ action: 'STOP_MODEL' });
      return { ok: true };
    }

    case 'UPDATE_EVENT_ACCEPTANCE':
      return updateEventAcceptance(msg.payload);

    case 'UPDATE_EVENT_METADATA':
      return updateEventMetadata(msg.payload);

    case 'SET_PRE_SESSION_TEXT': {
      const ts = msg.payload?.timestamp ?? Date.now();
      _lastSnapshotTimestamp = ts;
      await updateMetadata({ key: 'pre_session_snapshot', value: msg.payload?.text ?? '' });
      await updateMetadata({ key: 'last_snapshot_timestamp', value: ts });
      return { ok: true };
    }

    case 'FORCE_SCAN': {
      const session = await getSession();
      const tabId = session?.tabId;
      if (!tabId) return { ok: false, reason: 'no_active_tab' };
      try {
        const result = await chrome.tabs.sendMessage(tabId, { action: 'FORCE_SCAN' });
        return result ?? { ok: false, reason: 'no_response' };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }

    case 'GET_SNAPSHOT_AGE': {
      await _snapshotRestorePromise;
      const ageMs = _lastSnapshotTimestamp ? Date.now() - _lastSnapshotTimestamp : Infinity;
      return { ok: true, ageMs };
    }

    case 'SET_PENDING_AI_OUTPUT':
      _pendingAIOutput = {
        text: msg.payload?.text ?? '',
        subtype: msg.payload?.subtype ?? null,
        model: msg.payload?.model ?? null,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      chrome.storage.local.set({ pendingAIOutput: _pendingAIOutput }).catch(() => {});
      return { ok: true };

    case 'GET_PENDING_AI_OUTPUT':
      if (_pendingAIOutput && Date.now() < _pendingAIOutput.expiresAt) {
        return { ok: true, text: _pendingAIOutput.text, subtype: _pendingAIOutput.subtype, model: _pendingAIOutput.model };
      }
      _pendingAIOutput = null;
      chrome.storage.local.remove('pendingAIOutput').catch(() => {});
      return { ok: true, text: null, subtype: null, model: null };

    case 'CLEAR_PENDING_AI_OUTPUT':
      _pendingAIOutput = null;
      chrome.storage.local.remove('pendingAIOutput').catch(() => {});
      return { ok: true };

    case 'SELECTION_CHANGED':
      _lastSelection = msg.payload ?? { text: '' };
      chrome.runtime.sendMessage({ action: 'SELECTION_CONTEXT_UPDATE', ...msg.payload }).catch(() => {});
      return { ok: true };

    case 'UPDATE_DOC_CONTEXT':
      _lastDocContext = msg.payload ?? null;
      chrome.runtime.sendMessage({ action: 'DOC_CONTEXT_UPDATE', ...msg.payload }).catch(() => {});
      return { ok: true };

    case 'GET_DOC_CONTEXT':
      return _lastDocContext ?? null;

    case 'GET_SELECTION':
      return { ok: true, ..._lastSelection };

    case 'REQUEST_SETUP_SCRIPT': {
      const info = await chrome.runtime.getPlatformInfo();
      const extId = chrome.runtime.id;
      const platformOs = info.os; // 'win' | 'mac' | 'linux' — matches native-host/bin/<os>/
      if (!['win', 'mac', 'linux'].includes(platformOs)) {
        return { ok: false, error: `Local AI setup isn't available on this platform (${platformOs}).` };
      }
      // The native-host zip itself is downloaded by the caller (sidepanel.js),
      // not here — chrome.downloads.download() cannot source a
      // chrome-extension:// URL from a service worker (verified against a
      // real Chrome instance: it fails with interruptReason NETWORK_FAILED
      // regardless of web_accessible_resources), only from a page context.
      if (platformOs === 'win') {
        return { ok: true, script: _buildWindowsBat(extId), filename: 'colophon-setup.bat', platformOs };
      }
      // Same script content works on both — only the filename differs.
      // .command is a macOS Finder double-click convention with no meaning
      // on Linux, so Linux gets the more conventional .sh instead.
      const filename = platformOs === 'mac' ? 'colophon-setup.command' : 'colophon-setup.sh';
      return { ok: true, script: _buildPosixScript(extId), filename, platformOs };
    }

    default:
      throw new Error(`Unknown message type/action: ${route}`);
  }
}

// ── Session management ────────────────────────────────────────────────────────

// `chrome.storage.local.set()` fully replaces the stored session object,
// with no locking of its own. Every function below that does
// getSession() … mutate … saveSession() must run as one atomic unit
// relative to every other one, or whichever write finishes last silently
// discards the other's changes — the mechanism behind a real bug: a paste
// tag, acceptance update, or dismiss/review state could disappear because
// it raced maybeAutoExportAndTrim()'s own two-phase read-modify-write cycle
// (slow, since it exports and hashes the whole session in between its read
// and its write). A plain promise-chain mutex is enough here — MV3 service
// workers are single-threaded, so this only needs to serialize interleaved
// async cycles, never real concurrent threads.
let _sessionLock = Promise.resolve();

function withSessionLock(fn) {
  const run = _sessionLock.then(fn, fn);
  _sessionLock = run.then(() => {}, () => {});
  return run;
}

// `event.timestamp` used to double as every event's de facto unique ID
// throughout the codebase (UPDATE_EVENT_ACCEPTANCE/_METADATA/_STATE all did
// `session.events.find(e => e.timestamp === eventTimestamp)`, and the UI
// keyed its own DOM cards off it too) — but it's a real millisecond
// timestamp, not a true ID, and two events can land in the same millisecond
// (confirmed: runHeuristics() can flag two heuristic_suggestion tips in one
// synchronous pass). `event_id` is the real, collision-free identity;
// internal/storage-only — stripped in buildProcessLog() before export so the
// TWFF schema and hash chain are unaffected by this field's existence.
function pushEvent(session, event) {
  session.events.push({ event_id: crypto.randomUUID(), ...event });
}

async function startSession(args = {}) {
  return withSessionLock(() => _startSessionLocked(args));
}

async function _startSessionLocked({ tabId, docUrl, title } = {}) {
  const docId = docUrl ? await hashDocUrl(docUrl) : "";
  // The real (reversible) Google Docs id, distinct from the opaque docId hash
  // above — persisted so a background-triggered export (storage-quota
  // auto-export) can fetch the doc without needing an open/focused tab.
  const googleDocIdMatch = docUrl ? docUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) : null;
  const googleDocId = googleDocIdMatch ? googleDocIdMatch[1] : null;
  const now = new Date().toISOString();

  // ── Guard: do not create a new session if one is already actively recording
  // for this exact document. This prevents a spurious session_start event on
  // page reload when the user left recording on. The active session lives only
  // under the 'session' key (not in the per-docId archive) until it is stopped,
  // so checking getSessionByDocId() alone is insufficient.
  const activeSession = await getSession();
  if (activeSession?.isRecording && activeSession.docId === docId) {
    debugLog("[Colophon SW] startSession: already recording for this doc — reattaching only", { docId });
    if (tabId) {
      activeSession.tabId = tabId;
      await saveSession(activeSession);
      await activateContentScript(tabId);
    }
    return { ok: true, alreadyRecording: true, sessionId: activeSession.sessionId };
  }

  // Persist the currently-active session under its docId before switching away
  const prevSession = activeSession;
  if (prevSession?.docId && prevSession.docId !== docId) {
    await saveSessionByDocId(prevSession.docId, prevSession);
  }

  // Resume an existing session for this document if one exists
  let session = docId ? await getSessionByDocId(docId) : null;
  if (session) {
    session.isRecording = true;
    session.tabId = tabId ?? null;
    session.googleDocId = googleDocId ?? session.googleDocId ?? null;
    // Keep whatever title the session already has; a resume's title (e.g. a
    // stale tab title while the doc was loading) is never more reliable than
    // one already captured at the original session_start.
    session.title = session.title ?? title ?? null;
    pushEvent(session, { timestamp: now, type: "session_resume", meta: {} });
    debugLog("[Colophon SW] session_resume", { tabId: tabId ?? null, docId });
  } else {
    // Fresh, session-scoped anon ID — never persisted outside this session, so
    // every new session_start starts a brand new identity (TWFF spec §6.2).
    const userId = await generateUserId();
    session = {
      sessionId: crypto.randomUUID(),
      startedAt: now,
      tabId: tabId ?? null,
      docId,
      googleDocId,
      title: title ?? null,
      isRecording: true,
      events: [],
      userId,
      authors: { [userId]: { label: 'Author 1', color: '#5c3ce6' } },
      metadata: {
        assignment_prompt: ""
      }
    };
    pushEvent(session, { timestamp: now, type: "session_start", meta: {} });
    debugLog("[Colophon SW] session_start", { tabId: tabId ?? null, docId });
  }
  await saveSession(session);

  // Tell content script to activate its observers
  if (tabId) {
    await activateContentScript(tabId);
    // Snapshot the document state before any recording events — gives researchers a baseline
    try {
      const snap = await chrome.tabs.sendMessage(tabId, { action: 'GET_EDITOR_TEXT' });
      if (snap?.text) {
        const words = snap.text.trim().split(/\s+/).filter(Boolean).length;
        pushEvent(session, {
          timestamp: new Date().toISOString(),
          type: 'checkpoint',
          meta: {
            char_count_total: snap.text.length,
            word_count_total: words,
            _snapshot_hash: await sha256Hex(snap.text),
            note: 'pre-recording state',
          },
        });
        await saveSession(session);
        chrome.runtime.sendMessage({ action: 'SYNC_TIMELINE', events: session.events }).catch(() => {});
      }
    } catch { /* not on a Docs page or content script not ready */ }
  }

  return { ok: true, sessionId: session.sessionId };
}

/**
 * Auto-start a session from a content-script request (always-on recording).
 * Derives tab/url from the sender and refuses to disturb an already-recording
 * session, so it's safe to call on every Doc load.
 */
async function autoStartSession(sender) {
  const tabId = sender?.tab?.id ?? null;
  const docUrl = sender?.tab?.url ?? "";
  // Best available signal here: the service worker has no DOM access, only
  // whatever tab title Chrome already knew when this message arrived.
  const title = sender?.tab?.title ? formatDocTitle(sender.tab.title) : null;
  debugLog("[Colophon SW] auto session_start", { tabId, hasUrl: !!docUrl });
  // Delegate entirely to startSession(), which already compares the real
  // docId (not just "is anything recording") before deciding to reattach to
  // the existing session vs. switch to/create one for this doc. A bare
  // "already recording something" check here used to silently attach a
  // second, different Google Doc's real events to whichever doc's session
  // happened to be active first.
  return startSession({ tabId, docUrl, title });
}

async function stopSession() {
  return withSessionLock(_stopSessionLocked);
}

async function _stopSessionLocked() {
  const session = await getSession();
  if (!session) return { ok: false, reason: "no session" };

  session.isRecording = false;
  pushEvent(session, {
    timestamp: new Date().toISOString(),
    type: "session_end",
    meta: {},
  });
  debugLog("[Colophon SW] session_stop", {
    eventCount: session.events.length,
  });
  await saveSession(session);
  if (session.docId) await saveSessionByDocId(session.docId, session);

  if (session.tabId) {
    chrome.tabs
      .sendMessage(session.tabId, { type: "DEACTIVATE" })
      .catch(() => {});
  }

  return { ok: true };
}

async function appendEvent(event, sender) {
  return withSessionLock(() => _appendEventLocked(event, sender));
}

async function _appendEventLocked(event, sender) {
  const session = await getSession();
  if (!session?.isRecording) {
    debugLog("[Colophon SW] LOG_EVENT rejected", {
      type: event?.type ?? "unknown",
      reason: "not recording",
    });
    return { ok: false };
  }
  // The active session is pinned to one tab (session.tabId, set by
  // startSession/autoStartSession). A different tab's content script — e.g.
  // a second Google Doc that was opened and auto-started earlier, then
  // superseded as "active" when a third doc opened — must not have its real
  // edits silently folded into this session. Without this check, switching
  // between two open Docs tabs bleeds both documents' events into whichever
  // session happens to be active at the moment each event arrives.
  const senderTabId = sender?.tab?.id;
  if (session.tabId != null && senderTabId != null && senderTabId !== session.tabId) {
    debugLog("[Colophon SW] LOG_EVENT rejected", {
      type: event?.type ?? "unknown",
      reason: "sender tab is not the active session's tab",
      senderTabId,
      sessionTabId: session.tabId,
    });
    return { ok: false, reason: "inactive tab" };
  }
  if (isNoOpEditEvent(event)) {
    debugLog("[Colophon SW] LOG_EVENT ignored", {
      type: event?.type ?? "unknown",
      reason: "zero edit",
      meta: event?.meta,
    });
    return { ok: true, ignored: true };
  }
  const userId = await ensureSessionUserId(session);
  // Normalize the pre-v0.2 'edit' type string so every downstream consumer of
  // in-memory session events (popup, sidepanel, panel, storage.js) only ever
  // sees 'edit_block', regardless of which content-script version sent it.
  const normalizedType = event.type === 'edit' ? 'edit_block' : event.type;
  pushEvent(session, { author_id: userId, ...event, type: normalizedType });
  debugLog("[Colophon SW] LOG_EVENT stored", {
    type: event.type,
    meta: event.meta,
  });
  await saveSession(session);

  // Broadcast to Side Panel whenever an event is logged
  chrome.runtime.sendMessage({
    action: 'SYNC_TIMELINE',
    events: session.events
  }).catch(() => {});

  // A long session made of many small events (e.g. plain edit_block/
  // checkpoint events) can run for hours without ever nearing the storage
  // quota below, so the quota trigger alone never fires — the in-memory
  // session.events array (and the full array re-broadcast above) would grow
  // unbounded. This independent, count-based trigger forces the same
  // export+trim cycle periodically regardless of byte usage.
  _eventsSinceLastExportCheck += 1;
  let forceExportCheck = false;
  if (_eventsSinceLastExportCheck >= EVENT_COUNT_EXPORT_TRIGGER) {
    _eventsSinceLastExportCheck = 0;
    forceExportCheck = true;
  }

  // Fire-and-forget: chrome.storage.local has no unlimitedStorage permission
  // (Chrome's default ~10MB quota applies), so a very long session needs a
  // way to relieve pressure without ever losing data. Never awaited here —
  // exporting can be slow and must not block the LOG_EVENT response.
  maybeAutoExportAndTrim(forceExportCheck).catch((err) =>
    console.warn("[Colophon SW] auto-export/trim check failed", err)
  );

  return { ok: true };
}

const STORAGE_QUOTA_WARN_RATIO = 0.8;
let _autoExportInProgress = false;
let _eventsSinceLastExportCheck = 0;
const EVENT_COUNT_EXPORT_TRIGGER = 200;

// When storage usage nears its quota, durably export the full session (never
// deletes anything — the export is the safety net) and then aggregate old
// plain `edit` events into synthetic roll-ups. `edit` events carry no text
// snapshot at all (see flushEdit() in content.js — only position/char-delta
// bookkeeping), so this loses no reconstructable information; every event
// with acceptance/provenance value (ai_interaction, ai_suggestion,
// gemini_suggestion, paste, checkpoint, heuristic_suggestion) is never
// touched, since those carry the pedagogical/legal-evidentiary value.
async function maybeAutoExportAndTrim(force = false) {
  if (_autoExportInProgress) return;

  // `force` (the count-based trigger above) skips the quota check entirely
  // — it exists specifically for sessions that will never trip the quota.
  // Every other condition below (isRecording, googleDocId, the trim logic
  // itself) still applies either way.
  if (!force) {
    let usage;
    try {
      usage = await chrome.storage.local.getBytesInUse();
    } catch {
      return; // getBytesInUse unavailable — skip, don't risk a broken cycle
    }
    const quota = chrome.storage.local.QUOTA_BYTES ?? 10_485_760;
    if (usage < quota * STORAGE_QUOTA_WARN_RATIO) return;
  }

  // The whole export+trim cycle runs as one locked unit, including the
  // nested exportSession() call below — this (slow: it hashes and zips the
  // entire session) read-modify-write cycle used to run unlocked, so any
  // paste tag, acceptance update, or dismiss/review state change that
  // completed its own read-modify-write in the gap between this function's
  // two reads was silently discarded by whichever saveSession() landed last.
  return withSessionLock(_maybeAutoExportAndTrimLocked);
}

async function _maybeAutoExportAndTrimLocked() {
  const session = await getSession();
  if (!session?.isRecording) return;
  if (!session.googleDocId) return; // no tab-independent doc id — skip rather than risk a broken export

  _autoExportInProgress = true;
  try {
    await exportSession({ tabIndependent: true });

    // Re-fetch: more events may have been appended while exporting.
    const fresh = await getSession();
    if (!fresh?.isRecording) return;
    const trimmed = aggregateOldEditEvents(fresh.events);
    if (trimmed.changed) {
      fresh.events = trimmed.events;
      await saveSession(fresh);
      chrome.runtime.sendMessage({ action: 'SYNC_TIMELINE', events: fresh.events }).catch(() => {});
    }
    chrome.runtime.sendMessage({ action: 'AUTO_EXPORT_LIGHTENED' }).catch(() => {});
    debugLog("[Colophon SW] auto-export + trim complete", {
      eventsBefore: session.events.length,
      eventsAfter: trimmed.events.length,
    });
  } catch (err) {
    console.warn("[Colophon SW] auto-export failed, session left untouched", err);
  } finally {
    _autoExportInProgress = false;
  }
}

function isNoOpEditEvent(event) {
  if (event?.type !== "edit" && event?.type !== "edit_block") return false;
  const meta = event.meta ?? {};
  const deltaWords = Number(meta.delta_words ?? 0);
  const charDelta = Number(meta.char_delta ?? 0);
  const contentAfter = typeof meta.content_after === "string" ? meta.content_after : "";

  return contentAfter.length === 0
    && Number.isFinite(deltaWords)
    && Number.isFinite(charDelta)
    && deltaWords === 0
    && charDelta === 0;
}

async function getState() {
  const session = await getSession();
  if (!session) return { session: null, stats: null };

  const editCount = session.events.filter((e) => e.type === "edit" || e.type === "edit_block").length
    + session.events
        .filter((e) => e.type === "edit_summary")
        .reduce((sum, e) => sum + (e.meta?.source_event_count ?? 0), 0);
  const aiCount = session.events.filter(
    (e) => e.type === "ai_interaction",
  ).length;
  const elapsed = session.isRecording
    ? Date.now() - new Date(session.startedAt).getTime()
    : 0;

  return { session, stats: { editCount, aiCount, elapsed }, docContext: _lastDocContext };
}

// tabIndependent=true skips the active-tab requirement (needed when this is
// triggered from a background check, e.g. the storage-quota auto-export,
// rather than a user clicking "Export") — requires session.googleDocId to
// have been captured at startSession() time; older sessions without it fall
// back to the normal active-tab path and will throw if no Docs tab is open.
async function exportSession({ tabIndependent = false } = {}) {
  const session = await getSession();
  if (!session) throw new Error("No active session to export.");

  // Sessions created before this field existed won't have one yet — generate
  // and persist it now so it stays stable for the rest of this session.
  const hadUserId = Boolean(session.userId);
  const userId = await ensureSessionUserId(session);
  if (!hadUserId) await saveSession(session);

  const logger = new ProcessLog(userId);

  logger.sessionId = session.sessionId;
  logger.title = session.title;
  logger.startTime = session.startedAt;
  logger.events = session.events;

  const docId = tabIndependent ? (session.googleDocId ?? null) : null;
  if (tabIndependent && !docId) {
    throw new Error("No stored Google Doc id for this session — cannot export without an active tab.");
  }
  const exportData = await logger.export(docId);

  // Return the {filename, base64}
  return exportData;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashDocUrl(url) {
  const path = new URL(url).pathname;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(path),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function activateContentScript(tabId) {
  debugLog("[Colophon SW] activate content script", { tabId });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE" });
    debugLog("[Colophon SW] content script activated by message", { tabId });
    return;
  } catch {
    debugLog("[Colophon SW] content script message failed; injecting", {
      tabId,
    });
    // Already-open Docs tabs may not have the content script after extension reload.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
    debugLog("[Colophon SW] content script injected", { tabId });
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE" });
    debugLog("[Colophon SW] content script activated after inject", {
      tabId,
    });
  } catch (err) {
    console.warn("[Colophon] Could not activate content script:", err.message);
  }
}

// Helper function to update the session state for metadata.assignment_prompt

async function updateMetadata({ key, value }) {
  const session = await getSession()
  if (typeof session === 'undefined' || !session) {
    console.error("[Colophon BG] Cannot update metadata: Session not active.");
    return { status: 'error', message: 'Session not active' };
  }

  if (!session.metadata) {
    session.metadata = {};
  }

  session.metadata[key] = value;
  debugLog(`[Colophon BG] Metadata updated: ${key} =`, value);
  
  await saveSession(session);

  return { status: 'success' };
}

// Matches the 500-char cap applied everywhere else (spec v0.2 §6.1,
// lib/events.js's clip() calls) — this path (an accept/reject update arriving
// after the original event) used to allow up to 2000 chars, which was an
// inconsistency, not a deliberate wider allowance. It's safe to tighten now:
// annotate.js's classifyReliability()/insertedLength() were changed to read
// the true pre-truncation length from content_before_length/
// content_after_length (set below) instead of the capped string's own
// `.length`, so position/reliability classification no longer depends on
// having the untruncated text. Fuzzy-match *location* confidence for the
// truncated portion of insertions beyond 500 characters is a real, bounded,
// documented cost of this cap (see SPEC.md §4.4/§6.1) — not a bug.
const MAX_CONTENT_SNAPSHOT_CHARS = 500;

// `ref` is normally a real event_id (assigned by pushEvent() above). Falls
// back to a timestamp match for events that predate this field — an
// in-flight session started before an extension update can still contain
// events with no event_id at all.
function findEventByRef(session, ref) {
  if (!ref) return undefined;
  const byId = session.events.find(e => e.event_id === ref);
  if (byId) return byId;
  // Legacy-data safety net only: every real caller now supplies a real
  // event_id at creation time (see emitPaste()), so this timestamp match
  // should never actually be exercised going forward. Timestamps aren't
  // guaranteed unique (two pastes in the same millisecond), so warn if this
  // path ever matches more than one event — a silent match on the wrong
  // one would otherwise be invisible.
  const byTimestamp = session.events.filter(e => e.timestamp === ref);
  if (byTimestamp.length > 1) {
    debugLog('[Colophon SW] findEventByRef: ambiguous timestamp match', { ref, count: byTimestamp.length });
  }
  return byTimestamp[0];
}

// Bounded retry/backoff, ~1.1s total: covers emitPaste()'s own ~1000ms delay
// between showing the self-report prompt and actually calling LOG_EVENT, so
// a chip clicked quickly doesn't race the event's own creation. Previously
// updateEventAcceptance looked up the event once, silently no-opped on a
// miss, and still returned { status: 'success' } regardless — so a quietly
// wrong (or entirely dropped) acceptance/similarity_score write was
// invisible, with no error and no retry. Shared with updateEventMetadata
// below, which this mirrors exactly.
const METADATA_UPDATE_RETRY_DELAYS_MS = [0, 150, 350, 600];

async function updateEventAcceptance({ eventId, acceptance, similarity_score, content_before, content_after }) {
  for (const delay of METADATA_UPDATE_RETRY_DELAYS_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    const result = await withSessionLock(async () => {
      const session = await getSession();
      if (!session) return null;
      const event = findEventByRef(session, eventId);
      if (!event?.meta) return null;
      event.meta.acceptance = acceptance;
      // 0-1: how much of the AI's wording survived — spec v0.2 §4.4.
      if (similarity_score !== undefined) event.meta.similarity_score = similarity_score;
      if (content_before !== undefined) {
        event.meta.content_before_length = content_before.length;
        event.meta.content_before = content_before.slice(0, MAX_CONTENT_SNAPSHOT_CHARS);
      }
      if (content_after !== undefined) {
        event.meta.content_after_length = content_after.length;
        event.meta.content_after = content_after.slice(0, MAX_CONTENT_SNAPSHOT_CHARS);
      }
      await saveSession(session);
      chrome.runtime.sendMessage({
        action: 'SYNC_TIMELINE',
        events: session.events,
      }).catch(() => {});
      return { status: 'success' };
    });
    if (result) return result;
  }
  return { status: 'error', reason: 'event not found' };
}

async function updateEventMetadata({ eventId, key, value, via }) {
  if (!key) return { status: 'error', reason: 'missing key' };
  for (const delay of METADATA_UPDATE_RETRY_DELAYS_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    // Each attempt is its own short locked section — NOT the whole retry
    // loop — so the wait between attempts happens outside the lock. The
    // event this is retrying for is very often about to be created by a
    // pending appendEvent() call; holding the lock across the delay would
    // block that very appendEvent() from ever running, turning every retry
    // into a guaranteed, self-inflicted miss.
    const result = await withSessionLock(async () => {
      const session = await getSession();
      if (!session) return null;
      const event = findEventByRef(session, eventId);
      if (!event?.meta) return null;
      // For source_tool specifically, a correction is itself a meaningful
      // signal for a tamper-evident research instrument — record it as
      // data instead of silently overwriting the prior self-report with no
      // trace it ever happened. Scoped to this one key only: no other
      // metadata field has a concrete use case for a history trail yet.
      if (key === 'source_tool') {
        const history = event.meta.source_tool_history ?? [];
        history.push({ value, set_at: new Date().toISOString(), via: via ?? 'unknown' });
        event.meta.source_tool_history = history;
      }
      event.meta[key] = value;
      await saveSession(session);
      chrome.runtime.sendMessage({
        action: 'SYNC_TIMELINE',
        events: session.events,
      }).catch(() => {});
      return { status: 'success' };
    });
    if (result) return result;
  }
  return { status: 'error', reason: 'event not found' };
}

// ── Setup script builders ──────────────────────────────────────────────────────
//
// No Python dependency check here — the native host ships as a compiled
// binary (see native-host/build_native_host.py), so these scripts only need
// to unzip the already-downloaded platform binary into place and register it
// as a native-messaging host. Chrome doesn't let native scripts run from the
// extension itself, so this still has to be a separately downloaded file the
// user double-clicks once.

function _buildWindowsBat(extId) {
  return [
    '@echo off',
    'setlocal',
    '',
    'echo Colophon Local AI Setup',
    'echo =======================',
    'echo.',
    '',
    'set "ZIP=%USERPROFILE%\\Downloads\\colophon-setup\\colophon-host.zip"',
    'if not exist "%ZIP%" (',
    '  echo Could not find the downloaded setup file at:',
    '  echo   %ZIP%',
    '  echo Make sure the download finished, then run this file again.',
    '  pause & exit /b 1',
    ')',
    '',
    'set "DEST=%APPDATA%\\Colophon\\native-host"',
    'if not exist "%DEST%" mkdir "%DEST%"',
    '',
    'echo Installing native host...',
    'tar -xf "%ZIP%" -C "%DEST%"',
    'if %ERRORLEVEL% neq 0 (',
    '  echo ERROR: Could not extract files. Is the download complete?',
    '  pause & exit /b 1',
    ')',
    '',
    '> "%DEST%\\com.colophon.llamahost.json" (',
    '  echo {',
    '  echo   "name": "com.colophon.llamahost",',
    '  echo   "description": "Colophon local AI",',
    '  echo   "path": "%DEST:\\=\\\\%\\\\colophon-host.exe",',
    '  echo   "type": "stdio",',
    `  echo   "allowed_origins": ["chrome-extension://${extId}/"]`,
    '  echo }',
    ')',
    '',
    'reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.colophon.llamahost" /ve /t REG_SZ /d "%DEST%\\com.colophon.llamahost.json" /f 1>nul',
    'if %ERRORLEVEL% neq 0 (',
    '  echo ERROR: Could not write to Windows registry.',
    '  echo Try right-clicking this file and selecting "Run as administrator".',
    '  pause & exit /b 1',
    ')',
    '',
    'del "%ZIP%" >nul 2>&1',
    '',
    'echo.',
    'echo Setup complete! Return to Chrome and click "Check again" in Colophon.',
    'echo.',
    'pause',
  ].join('\r\n');
}

function _buildPosixScript(extId) {
  const TEMPLATE = `#!/bin/bash
echo "Colophon Local AI Setup"
echo "========================"
echo ""

ZIP="$HOME/Downloads/colophon-setup/colophon-host.zip"
if [ ! -f "$ZIP" ]; then
  echo "Could not find the downloaded setup file at:"
  echo "  $ZIP"
  echo "Make sure the download finished, then run this file again."
  read -p "Press Enter to close..."
  exit 1
fi

DEST="$HOME/.colophon/native-host"
mkdir -p "$DEST"

echo "Installing native host..."
unzip -o -q "$ZIP" -d "$DEST"
chmod +x "$DEST/colophon-host"

cat > "$DEST/com.colophon.llamahost.json" << MANIFEST
{
  "name": "com.colophon.llamahost",
  "description": "Colophon local AI",
  "path": "$DEST/colophon-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://__EXTID__/"]
}
MANIFEST

for cd in \\
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \\
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \\
  "$HOME/.config/google-chrome/NativeMessagingHosts" \\
  "$HOME/.config/chromium/NativeMessagingHosts"
do
  if [ -d "$(dirname "$cd")" ]; then
    mkdir -p "$cd"
    cp "$DEST/com.colophon.llamahost.json" "$cd/"
    echo "Installed to: $cd"
  fi
done

rm -f "$ZIP"

echo ""
echo "Setup complete! Return to Chrome and click Check in Colophon."
read -p "Press Enter to close..."
`;
  return TEMPLATE.replace('__EXTID__', extId);
}

async function updateEventState(args) {
  return withSessionLock(() => _updateEventStateLocked(args));
}

async function _updateEventStateLocked({ eventId, status }) {
  const session = await getSession();
  if (!session) return { status: 'error' };

  const event = findEventByRef(session, eventId);
  if (event) {
    if (!event.meta) event.meta = {};
    event.meta.status = status;
    await saveSession(session);
    
    chrome.runtime.sendMessage({
      action: 'SYNC_TIMELINE',
      events: session.events
    }).catch(() => {});
  }
  return { status: 'success' };
}

// Test seam only — this file has no other imports/exports since it's loaded
// as the MV3 background service worker entry point, never itself imported.
// Exporting these specific functions lets their logic (session-identity
// handling, event-ID collision resolution, the metadata-update retry) be
// unit tested directly against the same chrome.storage.local mock
// shared/storage.js's own tests already use, without needing to simulate
// the full onMessage/sender/tab machinery around them.
export {
  startSession,
  autoStartSession,
  stopSession,
  appendEvent,
  pushEvent,
  findEventByRef,
  updateEventAcceptance,
  updateEventMetadata,
  updateEventState,
  maybeAutoExportAndTrim,
  withSessionLock,
  handleMessage,
};
