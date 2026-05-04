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
})();
