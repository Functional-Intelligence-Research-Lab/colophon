// Event constructors for TWFF process-log events.
//
// Every constructor returns the runtime event shape used throughout Colophon:
//
//     { type, timestamp, meta: { ...schema fields } }
//
// The `meta` wrapper is REQUIRED: the service worker stores events this way, the
// side panel reads `evt.meta.*`, and — critically — the tamper-evident hash
// chain in shared/process-log.js hashes `event.meta`. Returning flat objects
// (fields at the top level) would blank the side-panel cards and hash
// `meta: undefined` for every event, silently destroying the integrity chain.
//
// Schema field coverage follows src/lib/schemas/process-log.schema.json (v0.2)./** ISO-8601 timestamp for "now". Helper so every constructor is consistent. */
function now() {
  return new Date().toISOString()
}

/** Truncate to `n` chars, tolerating null/undefined input. */
function clip(value, n) {
  return (value ?? '').slice(0, n)
}

/**
 * True length of a value, captured *before* truncation. Position/reliability
 * classification in annotate.js (classifyReliability, insertedLength) only
 * ever needs a length, never the substring itself — carrying this alongside
 * the capped content_before/content_after fields lets drift correction stay
 * accurate for long insertions without needing to raise the content cap
 * itself (spec v0.2 §6.1's 500-char privacy cap on stored text).
 */
function trueLength(value) {
  return (value ?? '').length
}

export function editEvent({ content, source, position_start, position_end, content_before, content_after, delta_words } = {}) {
  return {
    type: 'edit',
    timestamp: now(),
    meta: {
      content: content || '',
      source: source || 'human',
      position_start: position_start || 0,
      position_end: position_end || 0,
      content_before: clip(content_before, 500),
      content_after: clip(content_after, 500),
      delta_words: delta_words || 0,
    },
  }
}

export function pasteEvent({ char_count, source, position_start, position_end, content_preview } = {}) {
  return {
    type: 'paste',
    timestamp: now(),
    meta: {
      source: source || 'external',
      char_count: char_count || 0,
      position_start: position_start || 0,
      position_end: position_end || 0,
      content_preview: clip(content_preview, 100),
    },
  }
}

export function pasteLinkEvent({ url, link_scope, title, position } = {}) {
  return {
    type: 'paste_link',
    timestamp: now(),
    meta: {
      url: url || '',
      link_scope: link_scope || '',
      title: title || '',
      position: position || 0,
    },
  }
}

export function imageUploadEvent({ filename, file_type, position } = {}) {
  return {
    type: 'image_upload',
    timestamp: now(),
    meta: {
      filename: filename || '',
      file_type: file_type || '',
      position: position || 0,
    },
  }
}

export function aiInteractionEvent({ model, model_version, context_window, output_preview, content_before, content_after, position_start, position_end, acceptance, ai_chars, similarity_score, source, text, reason } = {}) {
  return {
    type: 'ai_interaction',
    timestamp: now(),
    meta: {
      model: model || '',
      model_version: model_version || '',
      context_window: context_window || '',
      output_preview: output_preview || '',
      content_before: clip(content_before, 500),
      content_after: clip(content_after, 500),
      content_before_length: trueLength(content_before),
      content_after_length: trueLength(content_after),
      position_start: position_start || 0,
      position_end: position_end || 0,
      acceptance: acceptance || '',
      ai_chars: ai_chars || 0,
      // 0-1: how much of the AI's wording survived into the kept text — spec
      // v0.2 §4.4, alongside (not instead of) acceptance.
      ...(similarity_score !== undefined ? { similarity_score } : {}),
      // Colophon runtime extras (not in the export schema but used by the UI):
      ...(source ? { source } : {}),
      ...(text ? { text } : {}),
      ...(reason ? { reason } : {}),
    },
  }
}

export function aiSuggestionEvent({ model, model_version, context_window, output_preview, content_before, content_after, position_start, position_end, acceptance, ai_chars, similarity_score, source, text } = {}) {
  return {
    type: 'ai_suggestion',
    timestamp: now(),
    meta: {
      model: model || '',
      model_version: model_version || '',
      context_window: context_window || '',
      output_preview: output_preview || '',
      content_before: clip(content_before, 500),
      content_after: clip(content_after, 500),
      content_before_length: trueLength(content_before),
      content_after_length: trueLength(content_after),
      position_start: position_start || 0,
      position_end: position_end || 0,
      acceptance: acceptance || '',
      ai_chars: ai_chars || 0,
      ...(similarity_score !== undefined ? { similarity_score } : {}),
      // The side panel renders suggestion cards from meta.text; keep the full
      // text (output_preview is only the first 100 chars).
      ...(source ? { source } : {}),
      ...(text ? { text } : {}),
    },
  }
}

export function checkpointEvent({ char_count_total, word_count_total, position } = {}) {
  return {
    type: 'checkpoint',
    timestamp: now(),
    meta: {
      char_count_total: char_count_total || 0,
      word_count_total: word_count_total || 0,
      position: position || 0,
    },
  }
}

export function focusChangeEvent({ direction, duration_ms } = {}) {
  return {
    type: 'focus_change',
    timestamp: now(),
    meta: {
      direction: direction || '',
      duration_ms: duration_ms || 0,
    },
  }
}

export function chatInteractionEvent({ model, message_count, message_preview, source_file } = {}) {
  return {
    type: 'chat_interaction',
    timestamp: now(),
    meta: {
      model: model || '',
      message_count: message_count || 0,
      message_preview: clip(message_preview, 100),
      source_file: source_file || '',
    },
  }
}

export function selectionEvent({ selectedText } = {}) {
  return {
    type: 'selection',
    timestamp: now(),
    meta: {
      selected_text: selectedText || '',
    },
  }
}

export function sessionStartEvent() {
  return {
    type: 'session_start',
    timestamp: now(),
    meta: {},
  }
}

export function sessionEndEvent() {
  return {
    type: 'session_end',
    timestamp: now(),
    meta: {},
  }
}

export function geminiSuggestionEvent({ char_count = 0, output_preview = '', insertion_velocity = 0, content_before = '', content_after = '', hash = '' } = {}) {
  return {
    type: 'gemini_suggestion',
    timestamp: now(),
    meta: {
      char_count,
      output_preview: clip(output_preview, 100),
      insertion_velocity,
      content_before: clip(content_before, 500),
      content_after: clip(content_after, 500),
      content_before_length: trueLength(content_before),
      content_after_length: trueLength(content_after),
      _hash: hash,
    },
  }
}
