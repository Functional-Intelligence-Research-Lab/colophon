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
  clearSession,
  ensureUserId,
} from "../shared/storage.js";
import { ProcessLog } from "../lib/process-log.js";
import { HOST_PY_B64 } from "../generated/host-py-b64.js";

// ── Native Messaging (llamafile host) ─────────────────────────────────────────

const NATIVE_HOST = 'com.colophon.llamahost';
let _nativePort = null;
let _modelStatus = 'unknown'; // 'unknown'|'host_not_installed'|'no_model'|'available'|'running'

function getNativePort() {
  if (_nativePort) return _nativePort;
  try {
    _nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    _nativePort.onMessage.addListener(onNativeMessage);
    _nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      console.log('[Colophon] Native host disconnected:', err);
      _nativePort = null;
      const notFound = err.toLowerCase().includes('not found') ||
                       err.toLowerCase().includes('specified native') ||
                       err.toLowerCase().includes('cannot find');
      _modelStatus = notFound ? 'host_not_installed' : 'disconnected';
      broadcastModelStatus();
    });
    return _nativePort;
  } catch (e) {
    console.log('[Colophon] Cannot connect to native host:', e.message);
    _nativePort = null;
    _modelStatus = 'host_not_installed';
    broadcastModelStatus();
    return null;
  }
}

function onNativeMessage(msg) {
  console.log('[Colophon] Native msg:', msg.action, msg);
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

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Colophon] Installed.");
});

// ── Message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      return startSession(msg); // Pass the whole msg so we can grab msg.title

    case "SESSION_STOP":
    case "endSession":
      return stopSession();

    case "LOG_EVENT":
      return appendEvent(msg.payload);

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
      const port = getNativePort();
      if (port) port.postMessage({ action: 'CHECK_MODEL' });
      return { ok: true, status: _modelStatus };
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

    case 'REQUEST_SETUP_SCRIPT': {
      const info = await chrome.runtime.getPlatformInfo();
      const extId = chrome.runtime.id;
      if (info.os === 'win') {
        return { ok: true, script: _buildWindowsBat(HOST_PY_B64, extId), filename: 'colophon-setup.bat' };
      }
      return { ok: true, script: _buildPosixScript(HOST_PY_B64, extId), filename: 'colophon-setup.command' };
    }

    default:
      throw new Error(`Unknown message type/action: ${route}`);
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function startSession({ tabId, docUrl } = {}) {
  await clearSession();

  const docId = docUrl ? await hashDocUrl(docUrl) : "";
  const now = new Date().toISOString();

  const session = {
    sessionId: crypto.randomUUID(),
    startedAt: now,
    tabId: tabId ?? null,
    docId,
    isRecording: true,
    events: [],
    metadata: {
      assignment_prompt: ""
    }
  };
  session.events.push({ timestamp: now, type: "session_start", meta: {} });
  console.log("[Colophon SW] session_start", { tabId: tabId ?? null, docId });
  await saveSession(session);

  // Tell content script to activate its observers
  if (tabId) {
    await activateContentScript(tabId);
    // Snapshot the document state before any recording events — gives researchers a baseline
    try {
      const snap = await chrome.tabs.sendMessage(tabId, { action: 'GET_EDITOR_TEXT' });
      if (snap?.text) {
        const words = snap.text.trim().split(/\s+/).filter(Boolean).length;
        session.events.push({
          timestamp: new Date().toISOString(),
          type: 'checkpoint',
          meta: {
            char_count_total: snap.text.length,
            word_count_total: words,
            _snapshot: snap.text.slice(0, 1500),
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

async function stopSession() {
  const session = await getSession();
  if (!session) return { ok: false, reason: "no session" };

  session.isRecording = false;
  session.events.push({
    timestamp: new Date().toISOString(),
    type: "session_end",
    meta: {},
  });
  console.log("[Colophon SW] session_stop", {
    eventCount: session.events.length,
  });
  await saveSession(session);

  if (session.tabId) {
    chrome.tabs
      .sendMessage(session.tabId, { type: "DEACTIVATE" })
      .catch(() => {});
  }

  return { ok: true };
}

async function appendEvent(event) {
  const session = await getSession();
  if (!session?.isRecording) {
    console.log("[Colophon SW] LOG_EVENT rejected", {
      type: event?.type ?? "unknown",
      reason: "not recording",
    });
    return { ok: false };
  }
  session.events.push(event);
  console.log("[Colophon SW] LOG_EVENT stored", {
    type: event.type,
    meta: event.meta,
  });
  await saveSession(session);

  // Broadcast to Side Panel whenever an event is logged
  chrome.runtime.sendMessage({ 
    action: 'SYNC_TIMELINE', 
    events: session.events 
  }).catch(() => {});

  return { ok: true };
}

async function getState() {
  const session = await getSession();
  if (!session) return { session: null, stats: null };

  const editCount = session.events.filter((e) => e.type === "edit").length;
  const aiCount = session.events.filter(
    (e) => e.type === "ai_interaction",
  ).length;
  const elapsed = session.isRecording
    ? Date.now() - new Date(session.startedAt).getTime()
    : 0;

  return { session, stats: { editCount, aiCount, elapsed } };
}

async function exportSession() {
  const session = await getSession();
  if (!session) throw new Error("No active session to export.");

  const userId = await ensureUserId();

  const logger = new ProcessLog(userId);

  logger.sessionId = session.sessionId;
  logger.title = session.title;
  logger.startTime = session.startedAt;
  logger.events = session.events;

  const exportData = await logger.export();

  // Return the {filename, base64}
  return exportData;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

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
  console.log("[Colophon SW] activate content script", { tabId });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE" });
    console.log("[Colophon SW] content script activated by message", { tabId });
    return;
  } catch {
    console.log("[Colophon SW] content script message failed; injecting", {
      tabId,
    });
    // Already-open Docs tabs may not have the content script after extension reload.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
    console.log("[Colophon SW] content script injected", { tabId });
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE" });
    console.log("[Colophon SW] content script activated after inject", {
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
  console.log(`[Colophon BG] Metadata updated: ${key} =`, value);
  
  await saveSession(session);

  return { status: 'success' };
}

async function updateEventAcceptance({ eventTimestamp, acceptance, content_before, content_after }) {
  const session = await getSession();
  if (!session) return { status: 'error' };

  const event = session.events.find(e => e.timestamp === eventTimestamp);
  if (event?.meta) {
    event.meta.acceptance = acceptance;
    if (content_before !== undefined) event.meta.content_before = content_before;
    if (content_after !== undefined) event.meta.content_after = content_after;
    await saveSession(session);
    chrome.runtime.sendMessage({
      action: 'SYNC_TIMELINE',
      events: session.events,
    }).catch(() => {});
  }
  return { status: 'success' };
}

// ── Setup script builders ──────────────────────────────────────────────────────

function _buildWindowsBat(b64, extId) {
  const chunkLines = [];
  const cs = 1900;
  for (let i = 0; i < b64.length; i += cs) {
    chunkLines.push(`  echo ${b64.slice(i, i + cs)}`);
  }

  return [
    '@echo off',
    'setlocal',
    '',
    'echo Colophon Local AI Setup',
    'echo =======================',
    'echo.',
    '',
    'python --version >nul 2>&1',
    'if %ERRORLEVEL% neq 0 (',
    '  echo Python is not installed.',
    '  echo.',
    '  echo Install Python from: https://www.python.org/downloads/',
    '  echo Check "Add Python to PATH" when installing, then run this file again.',
    '  start "" "https://www.python.org/downloads/"',
    '  pause & exit /b 1',
    ')',
    '',
    'set "DEST=%APPDATA%\\Colophon\\native-host"',
    'if not exist "%DEST%" mkdir "%DEST%"',
    '',
    'echo Installing host script...',
    '> "%TEMP%\\ch.b64" (',
    ...chunkLines,
    ')',
    'certutil -decode "%TEMP%\\ch.b64" "%DEST%\\host.py" >nul 2>&1',
    'del "%TEMP%\\ch.b64" >nul 2>&1',
    '',
    `python -c "import os; d=os.path.join(os.environ['APPDATA'],'Colophon','native-host'); q=chr(34); open(os.path.join(d,'host_wrapper.bat'),'w').write('@echo off\\npython '+q+os.path.join(d,'host.py')+q+' %%*\\n')"`,
    `python -c "import json,os; d=os.path.join(os.environ['APPDATA'],'Colophon','native-host'); m={'name':'com.colophon.llamahost','description':'Colophon local AI','path':os.path.join(d,'host_wrapper.bat'),'type':'stdio','allowed_origins':['chrome-extension://${extId}/']}; open(os.path.join(d,'com.colophon.llamahost.json'),'w').write(json.dumps(m,indent=2))"`,
    '',
    `for /f "usebackq tokens=*" %%P in (\`python -c "import os; print(os.path.join(os.environ['APPDATA'],'Colophon','native-host','com.colophon.llamahost.json'))"\`) do set "MP=%%P"`,
    'reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.colophon.llamahost" /ve /t REG_SZ /d "%MP%" /f >nul',
    '',
    'echo.',
    'echo Setup complete! Return to Chrome and click "Check again" in Colophon.',
    'echo.',
    'pause',
  ].join('\r\n');
}

function _buildPosixScript(b64, extId) {
  const TEMPLATE = `#!/bin/bash
echo "Colophon Local AI Setup"
echo "========================"
echo ""

if ! command -v python3 &>/dev/null; then
  echo "Python 3 is not installed."
  echo "Install from: https://www.python.org/downloads/"
  echo "Or with Homebrew: brew install python3"
  read -p "Press Enter to close..."
  exit 1
fi

python3 << 'PYEOF'
import base64, json, os, shutil

d = os.path.expanduser('~/.colophon/native-host')
os.makedirs(d, exist_ok=True)

with open(os.path.join(d, 'host.py'), 'wb') as f:
    f.write(base64.b64decode('__B64__'))
os.chmod(os.path.join(d, 'host.py'), 0o755)

m = {
    'name': 'com.colophon.llamahost',
    'description': 'Colophon local AI',
    'path': os.path.join(d, 'host.py'),
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://__EXTID__/']
}
p = os.path.join(d, 'com.colophon.llamahost.json')
with open(p, 'w') as f:
    json.dump(m, f, indent=2)

for cd in [
    os.path.expanduser('~/Library/Application Support/Google/Chrome/NativeMessagingHosts'),
    os.path.expanduser('~/Library/Application Support/Chromium/NativeMessagingHosts'),
    os.path.expanduser('~/.config/google-chrome/NativeMessagingHosts'),
    os.path.expanduser('~/.config/chromium/NativeMessagingHosts'),
]:
    if os.path.isdir(os.path.dirname(cd)):
        os.makedirs(cd, exist_ok=True)
        shutil.copy(p, cd)
        print('Installed to:', cd)

print('Setup complete!')
PYEOF

echo ""
echo "Return to Chrome and click Check in Colophon."
read -p "Press Enter to close..."
`;
  return TEMPLATE.replace('__B64__', b64).replace('__EXTID__', extId);
}

async function updateEventState({ eventTimestamp, status }) {
  const session = await getSession();
  if (!session) return { status: 'error' };

  const event = session.events.find(e => e.timestamp === eventTimestamp);
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
