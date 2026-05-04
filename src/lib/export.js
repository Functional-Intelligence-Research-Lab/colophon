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

// Minimal ZIP implementation for two JSON files.
// Uses the ZIP local-file-header + central-directory format.
function createZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(({ name, content }) => ({
    name: encoder.encode(name),
    data: encoder.encode(content)
  }));

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    // Local file header
    const local = new ArrayBuffer(30 + entry.name.length + entry.data.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // compression: store
    lv.setUint16(10, 0, true);            // mod time
    lv.setUint16(12, 0, true);            // mod date
    lv.setUint32(14, crc32(entry.data), true);
    lv.setUint32(18, entry.data.length, true);  // compressed size
    lv.setUint32(22, entry.data.length, true);  // uncompressed size
    lv.setUint16(26, entry.name.length, true);
    lv.setUint16(28, 0, true);            // extra field length

    const la = new Uint8Array(local);
    la.set(entry.name, 30);
    la.set(entry.data, 30 + entry.name.length);
    localHeaders.push(la);

    // Central directory header
    const central = new ArrayBuffer(46 + entry.name.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true);    // signature
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression: store
    cv.setUint16(12, 0, true);            // mod time
    cv.setUint16(14, 0, true);            // mod date
    cv.setUint32(16, crc32(entry.data), true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.name.length, true);
    cv.setUint16(30, 0, true);            // extra field length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number start
    cv.setUint16(36, 0, true);            // internal attributes
    cv.setUint32(38, 0, true);            // external attributes
    cv.setUint32(42, offset, true);       // local header offset

    const ca = new Uint8Array(central);
    ca.set(entry.name, 46);
    centralHeaders.push(ca);

    offset += la.length;
  }

  const centralDirSize = centralHeaders.reduce((s, h) => s + h.length, 0);
  const centralDirOffset = offset;

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralDirSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const lh of localHeaders) {
    result.set(lh, pos);
    pos += lh.length;
  }
  for (const ch of centralHeaders) {
    result.set(ch, pos);
    pos += ch.length;
  }
  result.set(new Uint8Array(eocd), pos);

  return result;
}

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export async function exportTwff() {
  const session = await getCurrentSession();
  if (!session) throw new Error("No active session to export.");

  const processLog = buildProcessLog(session);
  const metadata = await buildMetadata(session);

  const zipBytes = createZip([
    { name: "process-log.json", content: JSON.stringify(processLog, null, 2) },
    { name: "metadata.json", content: JSON.stringify(metadata, null, 2) }
  ]);

  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const filename = formatFilename();

  await chrome.downloads.download({ url, filename, saveAs: false });
  URL.revokeObjectURL(url);

  return filename;
}
