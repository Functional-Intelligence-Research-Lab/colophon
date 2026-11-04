/**
 * ollama-client.js — minimal OpenAI-compatible chat completion client.
 *
 * Works with both llamafile (http://127.0.0.1:8080) and Ollama (http://localhost:11434).
 * Uses the /v1/chat/completions endpoint that both servers expose.
 *
 * Response cleanup lives here, not in each caller, so every surface that
 * calls complete() gets an already-sanitized reply — a small/local model's
 * raw output can contain protocol artifacts (ChatML control tokens,
 * reasoning-model <think> blocks, or an echoed copy of the prompt-injection
 * fence this client wraps context in) that were never meant to reach the
 * user, and a cleanup step duplicated per-caller is exactly how one of
 * those got missed before.
 */

const DEFAULT_SYSTEM_PROMPT =
  'You are a concise writing assistant. Help the user improve their text. ' +
  'Keep replies short and direct. Do not add explanations unless asked.';

// Delimiter wrapped around doc/selection text sent to the model (see
// sidepanel.js's _fenceData) — a prompt-injection speed bump, not a
// guarantee. Exported so sidepanel.js uses this exact pair rather than
// keeping its own separate copy that cleanResponse() below wouldn't know
// about if the two ever drifted.
export const DATA_FENCE_OPEN = '<<<COLOPHON_DATA_START>>>';
export const DATA_FENCE_CLOSE = '<<<COLOPHON_DATA_END>>>';

// Meta-commentary prefixes small/local models sometimes prepend instead of
// just answering directly.
const META_COMMENTARY_PREFIXES = [
  /^the user wants me to\b[\s\S]*?\.\s*/i,
  /^i (?:will|should|need to) treat [\s\S]*?\.\s*/i,
  /^\[cursor\]\s*/i,
  /^the user(?:'s)? (?:writing|text) is:\s*/i,
  /^the completed sentence is:\s*/i,
  /^here is (?:the )?(?:paraphras\w*|revis\w*|rewritten) (?:text|version|sentence)?:?\s*/i,
  /^paraphras\w* version:?\s*/i,
  /^revis\w* version:?\s*/i,
  /^here'?s? (?:a |the )?(?:suggestion|revision|paraphrase):?\s*/i,
  /^(?:rewritten|revised|paraphrased):\s*/i,
];

/**
 * Normalize a raw model response into text that's safe to show, log, or
 * insert into a document. Strips protocol/structural artifacts first
 * (ChatML tokens, <think> reasoning blocks, echoed data fences), then
 * natural-language cleanup (JSON-wrapped replies, stray [CURSOR] tokens,
 * meta-commentary prefixes, wrapping quotes).
 *
 * @param {string} raw
 * @returns {string} cleaned text, possibly empty
 */
export function cleanResponse(raw) {
  if (!raw) return '';
  let t = raw.trim();

  // ChatML-style control tokens, e.g. <|im_start|>, <|endoftext|>.
  t = t.replace(/<\|[^|>]+\|>/g, '').trim();

  // <think>...</think> reasoning blocks (DeepSeek-R1/Qwen-reasoning-style
  // local models). Handle the unterminated case too: a dangling, never-
  // closed <think> was never meant to be shown, so truncate from its start
  // rather than leave half a reasoning trace visible.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const danglingThinkIndex = t.search(/<think>/i);
  if (danglingThinkIndex !== -1) t = t.slice(0, danglingThinkIndex).trim();

  // The Colophon data fences, if a model echoes part of its own prompt
  // back instead of (or alongside) a real answer. Only the exact marker
  // strings are removed — a label line like "Selection:" immediately
  // before an echoed fence can still remain; this covers the reported
  // case (the raw <<<...>>> markers themselves visible to the user), not
  // every possible echo shape.
  t = t.split(DATA_FENCE_OPEN).join('').split(DATA_FENCE_CLOSE).join('').trim();

  // Unwrap JSON-formatted responses (small models sometimes output {"key": "value"}).
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const strVal = Object.values(parsed).find(v => typeof v === 'string' && v.length > 5);
        if (strVal) t = strVal.trim();
      }
    } catch { /* not valid JSON */ }
  }

  // Stray [CURSOR] tokens the model may echo back.
  t = t.replace(/\[CURSOR\]/gi, '').trim();

  for (const re of META_COMMENTARY_PREFIXES) t = t.replace(re, '');

  // Surrounding quotation marks added by the model.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  return t;
}

/**
 * Identify which local server family an endpoint is, using the same
 * provider token the schema's own `model` field description already uses
 * as an example ("ollama/llama3", not some bespoke prefix) -- composed into
 * one "provider/name" string below rather than returned as a separate
 * field, since that's the convention every other producer in this codebase
 * (e.g. the Gemini path's "google/gemini") already follows, and neither
 * server reliably echoes back its own identity on its own (llamafile
 * ignores the requested `model` entirely).
 * @param {string} endpoint
 * @returns {string}
 */
function inferProvider(endpoint) {
  if (endpoint.includes(':11434')) return 'ollama';
  if (endpoint.includes(':8080')) return 'llamafile';
  return 'openai-compatible';
}

// A real paraphrase/grammar-fix intentionally shares most of its wording
// with the input -- a word-overlap similarity check would false-positive on
// exactly the cases where the feature is working correctly. A long verbatim
// run is the precise signal instead: an actual rewrite doesn't reproduce 60
// unbroken characters of the original prompt, but an echo (the model
// repeating part of what it was given instead of answering) does.
const ECHO_CHUNK_LENGTH = 60;

/**
 * Whether `responseText` contains a long verbatim run lifted straight from
 * `originalPrompt` -- a strong signal the model echoed its input (or the
 * fenced context within it) rather than producing a real answer.
 * @param {string} responseText
 * @param {string} originalPrompt
 * @returns {boolean}
 */
export function looksLikePromptEcho(responseText, originalPrompt) {
  if (!responseText || !originalPrompt) return false;
  if (responseText.length < ECHO_CHUNK_LENGTH) return false;
  // Every possible window, not a disjoint partition stepped by the window
  // size -- a partition can straddle a verbatim run across two blocks and
  // miss it entirely. Prompts/selections here are short (a few KB at most,
  // never a whole document), so the O(n) scan is cheap.
  for (let i = 0; i + ECHO_CHUNK_LENGTH <= originalPrompt.length; i++) {
    const chunk = originalPrompt.slice(i, i + ECHO_CHUNK_LENGTH);
    if (responseText.includes(chunk)) return true;
  }
  return false;
}

/**
 * Send a single-turn completion request.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {string} [opts.endpoint]     - Base URL of the inference server
 * @param {string} [opts.model]        - Model name (passed to the server; ignored by llamafile)
 * @param {string} [opts.systemPrompt] - Override default system prompt
 * @param {number} [opts.maxTokens]    - Max tokens to generate (default 256)
 * @returns {Promise<{text: string, model: string, empty: boolean}>}
 */
export async function complete(userMessage, opts = {}) {
  const endpoint = opts.endpoint || 'http://127.0.0.1:8080';
  const model = opts.model || 'local';
  const systemPrompt = opts.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const maxTokens = opts.maxTokens ?? 256;

  const url = `${endpoint}/v1/chat/completions`;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: maxTokens,
    stream: false,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = cleanResponse(raw);
    // An echo isn't "nothing," textually -- it's real-looking text that
    // happens to be the model repeating its own input back. Treat it the
    // same as an empty response: neither is a real answer worth logging,
    // rendering, or letting a user insert into their document.
    const text = looksLikePromptEcho(cleaned, userMessage) ? '' : cleaned;
    const modelName = data.model || model;
    return { text, model: `${inferProvider(endpoint)}/${modelName}`, empty: text.length === 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check whether the inference server is reachable.
 * @param {string} [endpoint]
 * @returns {Promise<boolean>}
 */
export async function isServerReady(endpoint = 'http://127.0.0.1:8080') {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    await fetch(`${endpoint}/health`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  }
}
