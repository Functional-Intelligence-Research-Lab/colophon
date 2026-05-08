import { exportTwff } from "../lib/export.js";
import { ProcessLog } from "../lib/process-log.js";

const idleView = document.getElementById("idle-view");
const activeView = document.getElementById("active-view");
const titleInput = document.getElementById("session-title");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnExport = document.getElementById("btn-export");
const eventCount = document.getElementById("event-count");
const messageEl = document.getElementById("message");


function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = false;
  setTimeout(() => { messageEl.hidden = true; }, 3000);
}

function showIdle() {
  idleView.hidden = false;
  activeView.hidden = true;
}

function showActive(session) {
  idleView.hidden = true;
  activeView.hidden = false;
  const count = session.events?.length || 0;
  eventCount.textContent = `${count} event${count !== 1 ? "s" : ""}`;
}

async function refreshUI() {
  const response = await chrome.runtime.sendMessage({ action: "getSession" });
  const session = response?.session;
  if (session && !session.ended) {
    showActive(session);
  } else {
    showIdle();
  }
}

btnStart.addEventListener("click", async () => {
  const title = titleInput.value.trim();
  await chrome.runtime.sendMessage({ action: "startSession", title });
  titleInput.value = "";
  await refreshUI();
  showMessage("Session started");
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "endSession" });
  await refreshUI();
  showMessage("Session ended");
});

btnExport.addEventListener("click", async () => {
  try {
    const filename = await exportTwff();
    showMessage(`Exported ${filename.filename}`);
  } catch (err) {
    showMessage(err.message);
  }
});

refreshUI();
