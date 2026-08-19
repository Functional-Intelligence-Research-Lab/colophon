/**
 * HTML-escapes a string for safe interpolation into innerHTML — both as
 * text content and inside a double-quoted attribute value.
 */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
