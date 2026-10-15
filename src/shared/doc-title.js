/**
 * Strips Chrome's " - Google Docs" tab-title suffix and falls back to a
 * plain, honest label when there's nothing usable left — never fabricates
 * a title.
 */
export function formatDocTitle(title = '') {
  return title
    .replace(/ - Google Docs$/i, '')
    .trim() || 'Untitled document'
}
