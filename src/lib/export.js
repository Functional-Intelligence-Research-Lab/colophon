// TWFF export: packages session into a .twff (ZIP) file
// Contains process-log.json and metadata.json

import { getCurrentSession } from "./session.js";

export async function exportTwff() {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "exportSession" }, (response) => {
            if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.error) {
                return reject(new Error(response.error));
            }
            resolve(response.filename);
        });
    });
}
