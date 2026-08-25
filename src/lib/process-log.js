import JSZip from './jszip.js';
import { computeEventHash } from '../shared/process-log.js';

// Annotation type registry
export const ANNOTATION_TYPES = {
    ai_paraphrase: {
        css_class: "ann-paraphrase",
        label: "AI Paraphrase",
        description: "Text rewritten by an AI assistant",
        log_type: "ai_interaction",
        interaction: "paraphrase",
    },
    ai_generated: {
        css_class: "ann-generated",
        label: "AI Generated",
        description: "Text written entirely by an AI assistant",
        log_type: "ai_interaction",
        interaction: "draft",
    },
    external_paste: {
        css_class: "ann-external",
        label: "External Source",
        description: "Text pasted from an external source",
        log_type: "paste",
        interaction: "external",
    },
    ai_completion: {
        css_class: "ann-completion",
        label: "AI Completion",
        description: "Tab-completed by Colophon",
        log_type: "ai_interaction",
        interaction: "completion",
    },
};

/**
 * Content caps enforced on export, matching TWFF spec v0.2 §6.1. `content_before`/
 * `content_after` are already clipped to 500 chars at event-creation time (see
 * lib/events.js's clip() calls) — this only needs to catch fields that are deliberately
 * left full at capture time for live UI rendering (e.g. the side panel reads meta.text to
 * render suggestion cards) but must still respect the spec's content caps once a session is
 * serialized into an exported/shareable .twff file.
 */
const EXPORT_TEXT_CAP = 500;

function sanitizeEventForExport(event) {
    const meta = event.meta;
    if (!meta || (meta.text === undefined && meta.reason === undefined)) return event;
    const sanitizedMeta = { ...meta };
    if (typeof sanitizedMeta.text === 'string') {
        sanitizedMeta.text = sanitizedMeta.text.slice(0, EXPORT_TEXT_CAP);
    }
    if (typeof sanitizedMeta.reason === 'string') {
        sanitizedMeta.reason = sanitizedMeta.reason.slice(0, EXPORT_TEXT_CAP);
    }
    return { ...event, meta: sanitizedMeta };
}

    /**
    * TWFF v0.2 process log.
    * Instantiate once per writing session. Call log_event() as the user writes.
    * Call export() to produce a .twff ZIP container as bytes.
     */
export class ProcessLog {
    static SPEC_VERSION = "0.2.0";

    constructor(userId = null) {
        this.sessionId = crypto.randomUUID();
        // Fallback to ephemeral ID if none provided
        this.userId = userId || this._generateEphemeralId();
        this.startTime = new Date().toISOString();
        this.events = [];
        this._contentSource = "content/document.xhtml";

        this.logEvent("session_start");
    }

    // --- Public API ---

    /**
    *Append a TWFF event to the log.  
    *@param {*} eventType One of the TWFF event type strings (session_start, edit,
    *                    paste, ai_interaction, chat_interaction, focus_change,
    *                    checkpoint, session_end).
    *@param {{}} [meta={}] Type-specific metadata object per the spec schema.
    *@returns {<Object>}The event object that was appended.
    */
    logEvent(eventType, meta = {}) {
        const event = {
            timestamp: new Date().toISOString(),
            type: eventType,
            meta: meta,
        };
        this.events.push(event);
        return event;
    }

    logCheckpoint(charCount, wordCount, cursorPosition) {
        return this.logEvent("checkpoint", {
            char_count_total: charCount,
            word_count_total: wordCount,
            position: cursorPosition,
        });
    }

    logEdit(positionStart, positionEnd, source = "human") {
        return this.logEvent("edit", {
            position_start: positionStart,
            position_end: positionEnd,
            source: source,
        });
    }

    logPaste(charCount, positionStart, positionEnd, source = "external", preview = "") {
        return this.logEvent("paste", {
            char_count: charCount,
            source: source,
            position_start: positionStart,
            position_end: positionEnd,
            output_preview: preview.substring(0, 100),
        });
    }

    logAiInteraction(
        interactionType, 
        model, 
        outputLength, 
        positionStart, 
        positionEnd, 
        outputPreview = "", 
        acceptance = "fully_accepted", 
        inputPreview = ""
    ) {
        return this.logEvent("ai_interaction", {
            interaction_type: interactionType,
            model: model,
            input_preview: inputPreview.substring(0, 100),
            output_preview: outputPreview.substring(0, 50),
            output_length: outputLength,
            position_start: positionStart,
            position_end: positionEnd,
            acceptance: acceptance,
        });
    }

    logFocusChange(durationMs) {
        return this.logEvent("focus_change", { duration_ms: durationMs });
    }

    /**
     * Finalise the session. Returns endTime ISO string
     */
    endSession() {
        const endTime = new Date().toISOString();
        this.logEvent("session_end");
        return endTime;
    }

    /**
     * @param {*} endTime
     * @returns Return the process log as a spec-compliant object
     */
    toDict(endTime = null) {
        return {
            version: ProcessLog.SPEC_VERSION,
            session_id: this.sessionId,
            user_id: this.userId,
            start_time: this.startTime,
            end_time: endTime || new Date().toISOString(),
            content_source: this._contentSource,
            events: this.events.map(sanitizeEventForExport),
        };
    }

    /**
     * Computes the per-event SHA-256 hash chain (spec §5.2) over
     * `processLogDict.events` — which must already be the sanitized/exported
     * shape (i.e. the output of toDict()), never the raw in-memory events —
     * so the chain always matches what actually gets written to
     * process-log.json. Mutates each event with `_hash` and sets
     * `processLogDict._integrity` in place.
     * @param {{events: Array, [key: string]: any}} processLogDict
     * @returns {Promise<void>}
     */
    async _applyIntegrityChain(processLogDict) {
        let previousHash = "";
        for (const event of processLogDict.events) {
            event._hash = await computeEventHash(event, previousHash, this.sessionId);
            previousHash = event._hash;
        }

        processLogDict._integrity = {
            algorithm: "SHA-256-CHAIN",
            chain_length: processLogDict.events.length,
            head_hash: previousHash,
            session_id: this.sessionId,
            note: "Per-event chained hash. Verify using spec §5.2.",
        };
    }

    /**
     * builds metadata for user session
     *
     * Uses the same `this.userId` set at construction (the session's single,
     * session-scoped author ID — see shared/storage.js's ensureSessionUserId)
     * rather than a second, independently-generated id, so metadata.json and
     * process-log.json always agree on who wrote a session.
     * @returns {{}} Metadata of user session
     */
    async buildMetadata() {
        return {
            title: this.title || 'colophone',
            created: new Date().toISOString(),
            twff_version: ProcessLog.SPEC_VERSION,
            author_id: this.userId,
            session_id: this.sessionId
        };
        }

    pad(n) {
        return String(n).padStart(2, "0");
        }

    formatFilename() {
        const d = new Date();
        const docPart = this._session?.docId ? `-${this._session.docId.slice(0, 8)}` : '';
        return `colophon-${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}-${this.pad(d.getHours())}-${this.pad(d.getMinutes())}${docPart}.twff`;
        }
    

    /**
     * Replaces relative image src attributes in XHTML with base64 data URIs
     * extracted from the EPUB zip, so images survive in the TWFF container.
     */
    async _inlineEpubImages(xhtmlString, loadedEpub, xhtmlFolder) {
        const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        const imgRe = /(<img[^>]*?src=")([^"]+)(")/gi;
        const replacements = [];
        let match;
        while ((match = imgRe.exec(xhtmlString)) !== null) {
            replacements.push({ full: match[0], prefix: match[1], src: match[2], suffix: match[3], index: match.index });
        }
        if (!replacements.length) return xhtmlString;

        // Build filename→zipKey lookup
        const fileMap = {};
        Object.keys(loadedEpub.files).forEach(k => { fileMap[k.split('/').pop()] = k; });

        let result = xhtmlString;
        for (const rep of replacements.reverse()) {
            const src = rep.src;
            if (src.startsWith('data:') || src.startsWith('http')) continue;
            // Resolve relative path
            let resolved = src.startsWith('/') ? src.slice(1) : xhtmlFolder + src;
            const parts = resolved.split('/');
            const norm = [];
            for (const p of parts) { if (p === '..') norm.pop(); else if (p && p !== '.') norm.push(p); }
            resolved = norm.join('/');
            const zipKey = loadedEpub.files[resolved] ? resolved : fileMap[src.split('/').pop()];
            if (!zipKey || loadedEpub.files[zipKey].dir) continue;
            try {
                const ext = (zipKey.split('.').pop() || '').toLowerCase();
                const mime = MIME[ext] || 'image/png';
                const b64 = await loadedEpub.files[zipKey].async('base64');
                const dataUri = `data:${mime};base64,${b64}`;
                result = result.slice(0, rep.index) + rep.prefix + dataUri + rep.suffix + result.slice(rep.index + rep.full.length);
            } catch { /* skip unreadable image */ }
        }
        return result;
    }

    /**
     * Loads EPUB file from Google Docs and extracts the main XHTML content.
     * Images are inlined as base64 data URIs so they survive in the TWFF container.
     * @returns {Promise<string>} XHTML string with inlined images.
     */
    async getXhtmlContentEpub(docId = null){
        // A real docId (the Google Docs id, not this project's opaque session
        // docId hash) lets a background-triggered export — e.g. the
        // storage-quota auto-export, which can't assume the Docs tab is
        // focused — skip the active-tab lookup entirely. The underlying
        // request is a credentialed fetch via the docs.google.com host
        // permission, so it never actually needed an open tab, only the id.
        if (!docId) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url) throw new Error("Could not find active tab.");

            const docIdMatch = tab.url.match(/\/d\/([a-zA-Z0-9-_]+)/);
            if (!docIdMatch) throw new Error("Not a valid Google Doc URL");
            docId = docIdMatch[1];
        }

        const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=epub`;
        const response = await fetch(exportUrl);
        const epubBlob = await response.blob();

        const zip = new JSZip();
        const loadedEpub = await zip.loadAsync(epubBlob);

        try {
            const opfKey = Object.keys(loadedEpub.files).find(k => k.endsWith('.opf'));
            if (opfKey) {
                const opfContent = await loadedEpub.files[opfKey].async("string");
                const spineMatch = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
                if (spineMatch) {
                    const idRefs = [...spineMatch[1].matchAll(/<itemref[^>]+idref="([^"]+)"/gi)].map(m => m[1]);
                    const targetId = (idRefs.length > 1 && idRefs[0].includes('titlepage')) ? idRefs[1] : idRefs[0];
                    const itemRegex = new RegExp(`<item[^>]+id="${targetId}"[^>]+href="([^"]+)"`, "i");
                    const itemMatch = opfContent.match(itemRegex);
                    if (itemMatch) {
                        const opfFolder = opfKey.includes('/') ? opfKey.substring(0, opfKey.lastIndexOf('/') + 1) : "";
                        const targetFilePath = opfFolder + itemMatch[1];
                        if (loadedEpub.files[targetFilePath]) {
                            const xhtmlFolder = targetFilePath.includes('/') ? targetFilePath.substring(0, targetFilePath.lastIndexOf('/') + 1) : "";
                            const raw = await loadedEpub.files[targetFilePath].async("string");
                            return await this._inlineEpubImages(raw, loadedEpub, xhtmlFolder);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn("OPF Map parsing failed, falling back to size heuristic...", err);
        }

        // SAFETY NET: FALLBACK TO LARGEST FILE
        const xhtmlFileKeys = Object.keys(loadedEpub.files).filter(fileName => {
            return (fileName.endsWith('.xhtml') || fileName.endsWith('.html'))
                   && !loadedEpub.files[fileName].dir;
        });
        if (xhtmlFileKeys.length === 0) throw new Error("Could not find any XHTML files inside the EPUB.");

        let mainContent = "", mainKey = "";
        for (const key of xhtmlFileKeys) {
            const c = await loadedEpub.files[key].async("string");
            if (key.includes('nav.xhtml')) continue;
            if (c.length > mainContent.length) { mainContent = c; mainKey = key; }
        }
        if (!mainContent) throw new Error("Failed to extract the main essay text.");

        const xhtmlFolder = mainKey.includes('/') ? mainKey.substring(0, mainKey.lastIndexOf('/') + 1) : "";
        return await this._inlineEpubImages(mainContent, loadedEpub, xhtmlFolder);
    }

    async getHtml() {
        // Finds the active Google Docs tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) throw new Error("Could not find active tab.");

        const docIdMatch = tab.url.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!docIdMatch) throw new Error("Not a valid Google Doc URL");
        const docId = docIdMatch[1];

        // uses content.js script to return base64 data
        const response = await chrome.tabs.sendMessage(tab.id, {
            action: "FETCH_DOC_EXPORT",
            docId: docId,
            format: "html"
        });

        if (response.error) {
            throw new Error("Content script failed: " + response.error);
        }

        // Loads the Base64 data that the content script sent us into JSZip
        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(response.base64, { base64: true });

        //Find all possible XHTML files
        const xhtmlFileKeys = Object.keys(loadedZip.files).filter(fileName => {
            return (fileName.endsWith('.xhtml') || fileName.endsWith('.html')) 
                   && !loadedZip.files[fileName].dir;
        });
        
        if (xhtmlFileKeys.length === 0) {
            throw new Error("Could not find any XHTML files inside the EPUB.");
        }
        
        // Read all xhtml files and keeps the largest one.
        // The title page and table of contents are tiny. The actual essay is huge.
        let mainContent = "";
        
        for (const key of xhtmlFileKeys) {
            const content = await loadedZip.files[key].async("string");
            
            // If we specifically hit the "nav" file, ignore it
            if (key.includes('nav.xhtml')) continue;

            // Keep whichever file has the most text in it
            if (content.length > mainContent.length) {
                mainContent = content;
            }
        }

        if (!mainContent) {
            throw new Error("Failed to extract the main essay text.");
        }

        return mainContent;
    }

    /**
     * Package content + process log into a TWFF ZIP container.
     * Note: This is an `async` function because the Web Crypto API
     * and JSZip generation are asynchronous. 
     * @returns {Promise<Blob>} A Blob representing the ZIP file.
     */
    async export(docId = null) {
        //const endTime = this.endSession();
        const processLogDict = this.toDict();
        await this._applyIntegrityChain(processLogDict);
        const xhtmlContent = await this.getXhtmlContentEpub(docId)
        //const xhtmlContent = await this.getHtml()
        const metaData = await this.buildMetadata()

        const manifest = this._buildManifest();

        // Requires JSZip library
        if (typeof JSZip === "undefined") {
            throw new Error("JSZip is required for export. Please include it in your extension.");
        }

        const zip = new JSZip();
        zip.file("content/document.xhtml", xhtmlContent);
        zip.file("meta/process-log.json", JSON.stringify(processLogDict, null, 2));
        zip.file("meta/metadata.json", JSON.stringify(metaData, null, 2));
        zip.file("meta/manifest.xml", manifest);


        //Generates downloadable Base64 zip file
        const base64Data = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
        const url = "data:application/octect-stream;base64," + base64Data
        const filename = this.formatFilename();      

        await chrome.downloads.download({ url, filename:filename, saveAs: false });
        
        //returns file name and base64 file data
        return {
            filename: filename,
            base64: base64Data
        };
    }

    // --- Private helpers ---
    /**
     * Defensive fallback for when a ProcessLog is constructed without a
     * userId. In production, service-worker.js always supplies one (via
     * shared/storage.js's ensureSessionUserId) before this class is
     * instantiated, so this path isn't normally hit — it just guarantees the
     * class never produces a log with a missing/undefined user_id.
     */
    _generateEphemeralId() {
        // Hashing a UUID4 (like in Python) is technically redundant for randomness.
        // We can just strip the dashes from a new UUID and take the first 12 chars
        // to get the exact same functional result synchronously.
        const raw = crypto.randomUUID().replace(/-/g, '');
        return "anon-" + raw.substring(0, 12);
    }

    _buildManifest() {
        return `<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <item id="content" href="content/document.xhtml" media-type="application/xhtml+xml"/>
  <item id="log" href="meta/process-log.json" media-type="application/json"/>
  <item id="metadata" href="meta/metadata.json" media-type="application/json"/>
</manifest>`;
    }
}