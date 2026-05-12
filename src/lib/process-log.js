import JSZip from './jszip.js';

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
        description: "Tab-completed by Glass Box",
        log_type: "ai_interaction",
        interaction: "completion",
    },
};

    /**
    * TWFF v0.1 process log.
    * Instantiate once per writing session. Call log_event() as the user writes.
    * Call export() to produce a .twff ZIP container as bytes.
     */
export class ProcessLog {
    static SPEC_VERSION = "0.1.0";

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
            events: this.events,
        };
    }

    /**
     * 
     * @returns {<String>} author ID
     */
    async getAuthorId() {
        const { authorId } = await chrome.storage.local.get("authorId");
        if (authorId) return authorId;
        const id = crypto.randomUUID();
        await chrome.storage.local.set({ authorId: id });
        return id;
        }

    /**
     * builds metadata for user session
     * @returns {{}} Metadata of user session
     */
    async buildMetadata() {
        const authorId = await this.getAuthorId();
        return {
            title: this.title || 'colophone',
            created: new Date().toISOString(),
            twff_version: "0.1",
            author_id: authorId,
            session_id: this.sessionId
        };
        }

    pad(n) {
        return String(n).padStart(2, "0");
        }

    formatFilename() {
        const d = new Date();
        return `colophon-${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}-${this.pad(d.getHours())}-${this.pad(d.getMinutes())}.twff`;
        }
    

    /**
     * loads EPUB file into memory from google docs
     * and extracts text content from xhtml file located in EPUB file
     * @returns {<String>} Content of main xhtml file located in EPUB file.
     */
    async getXhtmlContentEpub(){
        // Gets the URL from the currently active Chrome tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) throw new Error("Could not find active tab.");

        // Gets the Document ID
        const docIdMatch = tab.url.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!docIdMatch) throw new Error("Not a valid Google Doc URL");
        const docId = docIdMatch[1];

        // Fetch the EPUB version directly from Google's API
        const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=epub`;
        const response = await fetch(exportUrl);
        const epubBlob = await response.blob();

        //  Unzips the EPUB in memory
        const zip = new JSZip();
        const loadedEpub = await zip.loadAsync(epubBlob);

        //  Find the actual XHTML content file inside the EPUB
       //   by trying to read the EPUB's official map
        try {
            // Find the .opf file (the brain of the EPUB)
            const opfKey = Object.keys(loadedEpub.files).find(k => k.endsWith('.opf'));
            if (opfKey) {
                const opfContent = await loadedEpub.files[opfKey].async("string");
                
                // Find the <spine> (the official reading order) using regex
                const spineMatch = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
                if (spineMatch) {
                    // Get all the chapter IDs in order
                    const idRefs = [...spineMatch[1].matchAll(/<itemref[^>]+idref="([^"]+)"/gi)].map(m => m[1]);
                    
                    // Skip the title page if it exists and grab the first actual content ID.
                    const targetId = (idRefs.length > 1 && idRefs[0].includes('titlepage')) ? idRefs[1] : idRefs[0];

                    // Looks up the actual filename for that ID
                    const itemRegex = new RegExp(`<item[^>]+id="${targetId}"[^>]+href="([^"]+)"`, "i");
                    const itemMatch = opfContent.match(itemRegex);
                    
                    if (itemMatch) {
                        const opfFolder = opfKey.includes('/') ? opfKey.substring(0, opfKey.lastIndexOf('/') + 1) : "";
                        const targetFilePath = opfFolder + itemMatch[1];
                        
                        // If found perfectly, return it immediately!
                        if (loadedEpub.files[targetFilePath]) {
                            return await loadedEpub.files[targetFilePath].async("string");
                        }
                    }
                }
            }
        } catch (err) {
            console.warn("OPF Map parsing failed, falling back to size heuristic...", err);
        }

        // SAFETY NET: FALLBACK TO LARGEST FILE
        // If Google Docs changes their EPUB format and breaks the map reader above, 
        const xhtmlFileKeys = Object.keys(loadedEpub.files).filter(fileName => {
            return (fileName.endsWith('.xhtml') || fileName.endsWith('.html')) 
                   && !loadedEpub.files[fileName].dir;
        });
        
        if (xhtmlFileKeys.length === 0) {
            throw new Error("Could not find any XHTML files inside the EPUB.");
        }
        
        let mainContent = "";
        for (const key of xhtmlFileKeys) {
            const content = await loadedEpub.files[key].async("string");
            if (key.includes('nav.xhtml')) continue;
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
     * Mimicks python's json.dump
     * Note: Required for the integrity hash 
     * @param {*} obj object
     * @returns {<String>} A python styled JSON file.
     */
    pythonJsonDump(obj) {
        // Native stringify safely handle strings, numbers, booleans, and null
        if (obj === null || typeof obj !== 'object') {
            return JSON.stringify(obj);
        }

        // Handle Arrays: Map through items and join with a comma and a space
        if (Array.isArray(obj)) {
            const items = obj.map(item => this.pythonJsonDump(item));
            return `[${items.join(', ')}]`;
        }

        // Handle Objects: Sort keys alphabetically, then format with Python's colon and comma spaces
        const keys = Object.keys(obj).sort();
        const items = keys.map(key => {
            const safeKey = JSON.stringify(key);
            const safeValue = this.pythonJsonDump(obj[key]);
            return `${safeKey}: ${safeValue}`;
        });
        
        return `{${items.join(', ')}}`;
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
    async export() {
        //const endTime = this.endSession();
        const processLogDict = this.toDict();
        const xhtmlContent = await this.getXhtmlContentEpub()
        //const xhtmlContent = await this.getHtml()
        const metaData = await this.buildMetadata()

        // Compute integrity hash using the native Web Crypto API
        const eventsJson = this.pythonJsonDump(this.events);
        const salt = this.sessionId;
        const textEncoder = new TextEncoder();
        const dataToHash = textEncoder.encode(eventsJson + salt);
        
        const hashBuffer = await crypto.subtle.digest("SHA-256", dataToHash);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const integrityHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        processLogDict._integrity = {
            algorithm: "SHA-256",
            salt: "session_id",
            hash: integrityHash,
            note: "Hash of events array concatenated with session_id salt."
        };

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
     * Generate a short, anonymous, session-scoped user ID.
     * Not stored anywhere — user can rotate by refreshing. 
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