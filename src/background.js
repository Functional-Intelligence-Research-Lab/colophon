// import { createSession, addEvent, endSession, getCurrentSession, clearSession } from "./lib/session.js";
// import { editEvent, sessionStartEvent, sessionEndEvent } from "./lib/events.js";

// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//   handleMessage(message, sender).then(sendResponse);
//   return true; // keep channel open for async response
// });

// async function handleMessage(message) {
//   switch (message.action) {
//     case "startSession": {
//       const session = await createSession(message.title);
//       await addEvent(sessionStartEvent());
//       return { ok: true, session_id: session.session_id };
//     }

//     case "endSession": {
//       await addEvent(sessionEndEvent());
//       const session = await endSession();
//       return { ok: true, session };
//     }

//     case "getSession": {
//       const session = await getCurrentSession();
//       return { ok: true, session };
//     }

//     case "clearSession": {
//       await clearSession();
//       return { ok: true };
//     }

//     case "addEdit": {
//       const event = await addEvent(editEvent({
//         content: message.content,
//         source: message.source
//       }));
//       return { ok: true, event_id: event?.event_id };
//     }

//     default:
//       return { ok: false, error: "Unknown action" };
//   }
// }

// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
//   handleMessage(message, sender).then(sendResponse);
//   return true; // keep channel open for async response
// });

// async function handleMessage(message) {
//   switch (message.action) {
//     case "startSession": {
//       currentLogger = new ProcessLog();
//       currentLogger.title = request.title; // Attach the title from the UI
//        sendResponse({ success: true });
//        return true;
//     }

//     case "endSession": {
//       if (currentLogger) currentLogger.endSession();
//        sendResponse({ success: true });
//        return true;
//     }

//     case "getSession": {
//       if (!currentLogger) {
        //     sendResponse({ session: null });
        // } else {
        //     sendResponse({ session: currentLogger.toDict() });
        // }
        // return true;
//     }
//     case "exportSession" : {
    //   if (!currentLogger) {
    //             sendResponse({ error: "No active session to export." });
    //             return true;
    //         }
            
    //         // Trigger the export
    //         currentLogger.export()
    //             .then(filename => {
    //                 sendResponse({ filename: filename });
    //                 currentLogger = null; // Clear session after export
    //             })
    //             .catch(err => {
    //                 sendResponse({ error: err.message });
    //             });
                
    //         return true; // Keep the message channel open for the async export
//
//}

//     case "clearSession": {
//       await clearSession();
//       return { ok: true };
//     }

//     case "addEdit": {
//       const event = await addEvent(editEvent({
//         content: message.content,
//         source: message.source
//       }));
//       return { ok: true, event_id: event?.event_id };
//     }

//     default:
//       return { ok: false, error: "Unknown action" };
//   }
// }

import { ProcessLog } from "./lib/process-log.js";

// This is the global logger for the current session
let currentLogger = null; 

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    if (request.action === "startSession") {
        currentLogger = new ProcessLog();
        currentLogger.title = request.title; // Attach the title from the UI
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "endSession") {
        if (currentLogger) currentLogger.endSession();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "getSession") {
        if (!currentLogger) {
            sendResponse({ session: null });
        } else {
            sendResponse({ session: currentLogger.toDict() });
        }
        return true;
    }

    if (request.action === "exportSession") {
        if (!currentLogger) {
            sendResponse({ error: "No active session to export." });
            return true;
        }
        
        // Trigger the export
        currentLogger.export()
            .then(filename => {
                sendResponse({ filename: filename });
                currentLogger = null; // Clear session after export
            })
            .catch(err => {
                sendResponse({ error: err.message });
            });
            
        return true; // Keep the message channel open for the async export
    }
});