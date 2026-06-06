// Event constructors for TWFF process-log events

export function editEvent({content, source, position_start, position_end, content_before, content_after, delta_words}) {  
  return {
    type: "edit",
    content: content || "",
    source: source || "user",
    timestamp: new Date().toISOString(),
    position_start : position_start || 0,
    position_end : position_end || 0,
    content_before : content_before.slice(0,500) || '',
    content_after : content_after.slice(0,500) || '',
    delta_words : delta_words || 0,
    // _hash : hash
  };
}

export function pasteEvent({char_count,source, position_start, position_end, content_preview}) {
  return {
    type : "paste",
    timestamp : new Date().toISOString(),
    source : source || '',
    char_count : char_count || 0,
    position_start : position_start || 0,
    position_end : position_end || 0,
    content_preview : content_preview.slice(0,100),
    // _hash : hash
  }
}

export function pasteLinkEvent({url, link_scope, title, position}) {
  return {
    type : "paste_link",
    timestamp : new Date().toISOString,
    url : url || "",
    link_scope : link_scope || "",
    title : title || "",
    position : position || 0,
    // _hash : hash
  }
}

export function imageUploadEvent ({filename, file_type, position}) {
  return {
    type : "image_upload",
    timestamp : new Date().toISOString,
    filename : filename || "",
    file_type : file_type || "",
    position : position || 0,
    // _hash : hash
  }
}

export function aiInteractionEvent({model, model_version, context_window, output_preview, content_before, content_after, position_start, position_end, acceptance, ai_chars}) {
  return {
    type : "ai_interaction",
    timestamp : new Date().toISOString,
    model : model || "",
    model_version : model_version || '',
    context_window : context_window || '',
    output_preview : output_preview || '',
    content_before : content_before.slice(0,500) || '',
    content_after : content_after.slice(0,500) || '',
    position_start :position_start || 0,
    position_end : position_end || 0,
    acceptance : acceptance || "",
    ai_chars : ai_chars || 0,
    // _hash : hash
  }
}

export function aiSuggestionEvent({model, model_version, context_window, output_preview, content_before, content_after, position_start, position_end, acceptance, ai_chars}) {
  return {
    type : "ai_suggestion",
    timestamp : new Date().toISOString,
    model : model || "",
    model_version : model_version || '',
    context_window : context_window || '',
    output_preview : output_preview || '',
    content_before : content_before.slice(0,500) || '',
    content_after : content_after.slice(0,500) || '',
    position_start :position_start || 0,
    position_end : position_end || 0,
    acceptance : acceptance || '',
    ai_chars : ai_chars || 0,
    // _hash : hash
  }
}

export function checkpointEvent ({char_count_total, word_count_total, position}) {
  return {
    type : "checkpoint",
    timestamp : new Date().toISOString(),
    char_count_total : char_count_total || 0,
    word_count_total : word_count_total || 0,
    position : position || 0,
    // _hash : hash
  }
}

export function focusChangeEvent ({direction, duration_ms}) {
  return {
    type : "focus_change",
    timestamp : new Date().toISOString(),
    direction : direction || '',
    duration_ms : duration_ms || 0,
    // _hash : hash
  }
}

export function chatInteractionEvent ({model, message_count, message_preview, source_file}) {
  return {
    type : "chat_interaction",
    timestamp : new Date().toISOString(),
    model : model || '',
    message_count : message_count || 0,
    message_preview : message_preview.slice(0,100) || '',
    source_file : source_file || '',
    // _hash : hash
  }
}

export function selectionEvent({ selectedText }) {
  return {
    type: "selection",
    selected_text: selectedText || ""
    // _hash : hash
  };
}

export function sessionStartEvent() {
  return {
    type: "session_start",
    timestamp: new Date().toISOString(),
    // _hash : hash
  };
}

export function sessionEndEvent() {
  return {
    type: "session_end",
    timestamp: new Date().toISOString(),
    // _hash : hash
  };
}


