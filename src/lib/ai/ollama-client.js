/**
 * ollama-client.js — minimal OpenAI-compatible chat completion client.
 *
 * Works with both llamafile (http://127.0.0.1:8080) and Ollama (http://localhost:11434).
 * Uses the /v1/chat/completions endpoint that both servers expose.
 */

const DEFAULT_SYSTEM_PROMPT =
  'You are a concise writing assistant. Help the user improve their text. ' +
  'Keep replies short and direct. Do not add explanations unless asked.';

/**
 * Send a single-turn completion request.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {string} [opts.endpoint]     - Base URL of the inference server
 * @param {string} [opts.model]        - Model name (passed to the server; ignored by llamafile)
 * @param {string} [opts.systemPrompt] - Override default system prompt
 * @param {number} [opts.maxTokens]    - Max tokens to generate (default 256)
 * @returns {Promise<{text: string, model: string}>}
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
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    const modelName = data.model || model;
    return { text, model: modelName };
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
