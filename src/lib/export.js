// TWFF export: packages session into a .twff (ZIP) file
// Contains process-log.json and metadata.json

import { getCurrentSession } from "./session.js";

export async function getAuthorId() {
  const { authorId } = await chrome.storage.local.get("authorId");
  if (authorId) return authorId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ authorId: id });
  return id;
}

function buildProcessLog(session) {
  return {
    session_id: session.session_id,
    events: session.events
  };
}

async function buildMetadata(session) {
  const authorId = await getAuthorId();
  return {
    title: session.title,
    created: session.created,
    twff_version: "0.1",
    author_id: authorId,
    session_id: session.session_id
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatFilename() {
  const d = new Date();
  return `colophon-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}.twff`;
}

// ZIP implementation for two JSON files using JSZip library.
// Uses the JSZip library

export async function exportTwff() {
  const session = await getCurrentSession();
  if (!session) throw new Error("No active session to export.");

  const processLog = buildProcessLog(session);
  const metadata = await buildMetadata(session);

  const zip = new JSZip()

  zip.file('metadata.json',JSON.stringify(metadata, null, 2))
  zip.file('process-log.json', JSON.stringify(processLog, null, 2))

  const base64Data = await zip.generateAsync({type : "base64"})
  const url = "data:application/octect-stream;base64," + base64Data
  const filename = formatFilename();

  await chrome.downloads.download({ url, filename:filename, saveAs: false });

  return filename;
}
