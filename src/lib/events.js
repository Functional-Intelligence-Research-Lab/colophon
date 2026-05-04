// Event constructors for TWFF process-log events

export function editEvent({ content, source }) {
  return {
    type: "edit",
    content: content || "",
    source: source || "user"
  };
}

export function selectionEvent({ selectedText }) {
  return {
    type: "selection",
    selected_text: selectedText || ""
  };
}

export function sessionStartEvent() {
  return {
    type: "session_start"
  };
}

export function sessionEndEvent() {
  return {
    type: "session_end"
  };
}
