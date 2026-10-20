/**
 * source-tools.js: Shared definitions and helpers for paste source tagging.
 *
 * Colophon records authentic student process logs. When text is pasted from an
 * external source, the student can self-report which tool (AI or non-AI) it
 * came from.
 *
 * In accordance with Colophon's core philosophy, this is strictly a self-report
 * tag and must NEVER be described, labeled, or implied as an automated detection.
 */

export const VALID_SOURCE_TOOLS = [
  'chatgpt',
  'claude',
  'copilot',
  'gemini',
  'perplexity',
  'deepseek',
  'other_ai',
  'not_ai',
];

export const SOURCE_TOOL_LABELS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  copilot: 'Microsoft Copilot',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
  other_ai: 'Other AI',
  not_ai: 'Not AI-generated',
};

export const SOURCE_TOOLS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'other_ai', label: 'Other AI' },
  { id: 'not_ai', label: 'Not AI-generated' },
];

/**
 * Returns human-readable label for a given source tool key.
 * @param {string} toolKey
 * @returns {string}
 */
export function getSourceToolLabel(toolKey) {
  return SOURCE_TOOL_LABELS[toolKey] || toolKey || '';
}

/**
 * Formats a display string honestly labeled as self-reported.
 * @param {string} toolKey
 * @returns {string}
 */
export function formatSelfReportedLabel(toolKey) {
  if (!toolKey) return '';
  const label = getSourceToolLabel(toolKey);
  return `Self-reported source: ${label}`;
}

