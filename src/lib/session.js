// Session lifecycle management
// Sessions are stored in chrome.storage.local under the key "sessions"

export function generateId() {
  return crypto.randomUUID();
}

export function now() {
  return new Date().toISOString();
}

export function generateUserId() {
  return 'anon-'.concat(crypto.randomUUID())
}

export async function createSession(title) {
  const session = {
    session_id: generateId(),
    user_id: generateUserId(),
    //title: title || "Untitled session",
    created: now(),
    ended: null,
    events: []
  };
  await chrome.storage.local.set({ currentSession: session });
  return session;
}

export async function getCurrentSession() {
  const { currentSession } = await chrome.storage.local.get("currentSession");
  return currentSession || null;
}

export async function addEvent(event) {
  const session = await getCurrentSession();
  if (!session) return null;

  event.event_id = generateId();
  event.timestamp = now();
  session.events.push(event);

  await chrome.storage.local.set({ currentSession: session });
  return event;
}

export async function endSession() {
  const session = await getCurrentSession();
  if (!session) return null;

  session.ended = now();
  await chrome.storage.local.set({ currentSession: session });
  return session;
}

export async function clearSession() {
  await chrome.storage.local.remove("currentSession");
}
