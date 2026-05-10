// Content script for Google Docs edit capture.
// Google Docs renders in an iframe with class "docs-texteventtarget-iframe"
// and uses contenteditable divs. We observe DOM mutations and keyboard input
// to detect user edits, then forward them to the background service worker.

(function () {
  "use strict";

  let debounceTimer = null;
  const DEBOUNCE_MS = 1500;
  let lastSnapshot = "";

  function getDocBody() {
    // Google Docs main editing surface
    const editRegion = document.querySelector(".kix-appview-editor");
    return editRegion;
  }

  function getDocText() {
    const body = getDocBody();
    if (!body) return "";
    // Collect text from the rendered paragraphs
    const lines = body.querySelectorAll(".kix-paragraphrenderer");
    return Array.from(lines).map(p => p.textContent).join("\n");
  }

  function sendEdit(content) {
    chrome.runtime.sendMessage({
      action: "addEdit",
      content: content,
      source: "user"
    });
  }

  function onMutation() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const current = getDocText();
      if (current !== lastSnapshot) {
        sendEdit(current);
        lastSnapshot = current;
      }
    }, DEBOUNCE_MS);
  }

  function init() {
    const target = getDocBody();
    if (!target) {
      // Google Docs may not have loaded yet; retry
      setTimeout(init, 2000);
      return;
    }

    lastSnapshot = getDocText();

    const observer = new MutationObserver(onMutation);
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Wait for the page to settle, then start observing
  setTimeout(init, 3000);

  // =================================================================
  // PART 2: EXPORT FETCHER (Bypasses Google authentication blocks)
  // =================================================================
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "FETCH_DOC_EXPORT") {
        // Run the fetch function and send the base64 data back to the background script
        forceFetchExport(request.docId, request.format)
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ error: err.message }));
            
        return true; // Tells Chrome we will send the response asynchronously
    }
  });

  async function forceFetchExport(docId, format) {
    const url = `https://docs.google.com/document/d/${docId}/export?format=${format}`;
    
    // Because we are ON the page, we naturally use the user's active Google login
    const res = await fetch(url);
    
    if (!res.ok) {
        throw new Error(`Google blocked Content Script fetch: ${res.status}`);
    }

    const blob = await res.blob();
    
    // Convert the Blob to a Base64 string to safely cross the Chrome message bridge
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64data = reader.result.split(',')[1]; 
            resolve({ base64: base64data });
        };
        reader.readAsDataURL(blob);
    });
  }
})();
