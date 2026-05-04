import { createSession, addEvent, endSession, getCurrentSession, clearSession } from "./lib/session.js";
import { editEvent, sessionStartEvent, sessionEndEvent } from "./lib/events.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  switch (message.action) {
    case "startSession": {
      const session = await createSession(message.title);
      await addEvent(sessionStartEvent());
      return { ok: true, session_id: session.session_id };
    }

    case "endSession": {
      await addEvent(sessionEndEvent());
      const session = await endSession();
      return { ok: true, session };
    }

    case "getSession": {
      const session = await getCurrentSession();
      return { ok: true, session };
    }

    case "clearSession": {
      await clearSession();
      return { ok: true };
    }

    case "addEdit": {
      const event = await addEvent(editEvent({
        content: message.content,
        source: message.source
      }));
      return { ok: true, event_id: event?.event_id };
    }

    default:
      return { ok: false, error: "Unknown action" };
  }
}
