// similarity.js — word-set similarity between an AI suggestion and kept text.
//
// Used to compute TWFF's `similarity_score` field (spec v0.2 §4.4): a 0.0-1.0
// description of how much of an AI suggestion's wording survived into the
// final text, alongside — never in place of — the discrete `acceptance`
// bucket. Shared by sidepanel.js (side-panel-originated suggestions) and
// gemini-detector.js (native Gemini suggestions) so both acceptance-scoring
// paths produce a comparable number.

/** Jaccard similarity over unique lowercased word tokens — order- and
 * duplicate-insensitive, so paraphrasing that reorders words still scores
 * as similar. */
export function jaccardSimilarity(a, b) {
  const words = s => new Set((s || '').toLowerCase().match(/\b\w+\b/g) || []);
  const setA = words(a);
  const setB = words(b);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Discrete acceptance bucket from a similarity score — matches TWFF spec
 * v0.2's ai_interaction/ai_suggestion `acceptance` enum. */
export function acceptanceFromSimilarity(score) {
  if (score >= 0.9) return 'fully_accepted';
  if (score >= 0.5) return 'partially_accepted';
  if (score >= 0.1) return 'modified';
  return 'rejected';
}
