
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
