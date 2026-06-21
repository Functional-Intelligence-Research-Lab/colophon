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
  if (tabId) await activateContentScript(tabId);

  return { ok: true, sessionId: session.sessionId };
}

/**
 * Auto-start a session from a content-script request (always-on recording).
 * Derives tab/url from the sender and refuses to disturb an already-recording
 * session, so it's safe to call on every Doc load.
 */
async function autoStartSession(sender) {
  const existing = await getSession();
  if (existing?.isRecording) {
    return { ok: true, alreadyRecording: true, sessionId: existing.sessionId };
  }
  const tabId = sender?.tab?.id ?? null;
  const docUrl = sender?.tab?.url ?? "";
  console.log("[Colophon SW] auto session_start", { tabId, hasUrl: !!docUrl });
  return startSession({ tabId, docUrl });
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
  if (isNoOpEditEvent(event)) {
    console.log("[Colophon SW] LOG_EVENT ignored", {
      type: event?.type ?? "unknown",
      reason: "zero edit",
      meta: event?.meta,
    });
    return { ok: true, ignored: true };
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

function isNoOpEditEvent(event) {
  if (event?.type !== "edit") return false;
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
