/**
 * heuristics.js — Grammarly-style lightweight local text analysis
 *
 * Pure synchronous analysis, no network, no AI inference.
 * Returns an array of suggestion objects ready to be emitted as
 * 'heuristic_suggestion' events in the timeline.
 */

// ── Sentence-level helpers ─────────────────────────────────────────────────────

const PASSIVE_RE = /\b(was|were|is|are|be|been|being)\s+\w+ed\b/gi;

const WEAK_WORDS = new Set([
  'very', 'quite', 'rather', 'really', 'just', 'basically', 'actually',
  'literally', 'somewhat', 'sort of', 'kind of', 'pretty much', 'maybe',
  'perhaps', 'probably', 'generally', 'usually', 'honestly',
]);

const WORDY_PHRASES = [
  [/\bin order to\b/gi,               'to'],
  [/\bdue to the fact that\b/gi,       'because'],
  [/\bat this point in time\b/gi,      'now'],
  [/\bin the event that\b/gi,          'if'],
  [/\bfor the purpose of\b/gi,         'to'],
  [/\bwith regard to\b/gi,             'about'],
  [/\bin spite of the fact that\b/gi,  'although'],
  [/\bat the present time\b/gi,        'currently'],
  [/\bthe majority of\b/gi,            'most'],
  [/\ba large number of\b/gi,          'many'],
  [/\bit is important to note that\b/gi, ''],
  [/\bplease be advised that\b/gi,     ''],
];

function adverbRatio(text) {
  const words = text.match(/\b\w+\b/g) ?? [];
  if (words.length < 50) return 0;
  const adverbs = words.filter(w => /ly$/i.test(w) && w.length > 4);
  return adverbs.length / words.length;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * @param {string} text - Plain text of the document
 * @returns {{ text: string, excerpt: string }[]}
 */
export function analyzeText(text) {
  if (!text || text.trim().length < 60) return [];

  const suggestions = [];
  const seen = new Set();

  const add = (rule, tipText, excerpt = '') => {
    if (!seen.has(tipText)) {
      seen.add(tipText);
      suggestions.push({ rule, text: tipText, excerpt: excerpt.trim().slice(0, 150) });
    }
  };

  // ── 2. Adverb overuse (whole document) ────────────────────────────────────
  const advRatio = adverbRatio(text);
  if (advRatio > 0.05) {
    add('adverb_density', `High adverb density (${(advRatio * 100).toFixed(0)}% of words end in -ly). Consider replacing adverbs with stronger verbs.`, '');
  }

  // ── Per-paragraph checks ───────────────────────────────────────────────────
  const paragraphs = text.split(/\n{2,}/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length < 30) continue;

    const paraWords = trimmed.split(/\s+/);

    // 1. Long paragraph
    if (paraWords.length > 350) {
      add(
        'long_paragraph',
        `Very long paragraph (${paraWords.length} words). Consider splitting it into sections.`,
        trimmed.slice(0, 80)
      );
    }

    /* passive_voice — temporarily disabled
    const passiveMatches = trimmed.match(PASSIVE_RE) ?? [];
    if (passiveMatches.length >= 2) {
      const excerpt = passiveMatches.slice(0, 2).join(', ');
      add(
        'passive_voice',
        `Passive voice detected ${passiveMatches.length} time${passiveMatches.length > 1 ? 's' : ''} in this paragraph (e.g. "${excerpt}"). Consider rewriting in active voice.`,
        trimmed.slice(0, 80)
      );
    }
    */

    // 5. Weak/filler words — word-boundary match, not substring: a plain
    // `.includes()` check flags "every" as containing "very" and "adjust"/
    // "justice"/"justify" as containing "just".
    const lowerPara = trimmed.toLowerCase();
    const foundWeak = [...WEAK_WORDS].filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lowerPara));
    if (foundWeak.length >= 2) {
      add(
        'filler_words',
        `Weak filler words found: ${foundWeak.slice(0, 4).map(w => `"${w}"`).join(', ')}. Try removing or replacing them for a stronger voice.`,
        trimmed.slice(0, 80)
      );
    }

    /* wordy_phrase — temporarily disabled
    for (const [re, replacement] of WORDY_PHRASES) {
      const m = trimmed.match(re);
      if (m) {
        const phrase = m[0];
        const tip = replacement
          ? `"${phrase}" is wordy. Consider replacing with "${replacement}".`
          : `"${phrase}" is unnecessary — try removing it.`;
        add('wordy_phrase', tip, trimmed.slice(0, 80));
      }
    }
    */

    // ── Per-sentence checks ────────────────────────────────────────────────
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);

    // 7. Long sentences
    for (const s of sentences) {
      const wc = s.split(/\s+/).length;
      if (wc > 40) {
        add(
          'long_sentence',
          `Long sentence (${wc} words). Consider splitting it for clarity.`,
          s.slice(0, 80) + (s.length > 80 ? '…' : '')
        );
      }
    }

    // 8. Repeated sentence starts (monotone structure)
    if (sentences.length >= 3) {
      const starts = sentences.map(s => s.trim().split(/\s+/)[0]?.toLowerCase() ?? '');
      let streak = 1;
      for (let i = 1; i < starts.length; i++) {
        if (starts[i] && starts[i] === starts[i - 1]) {
          streak++;
          if (streak >= 3) {
            add(
              'repeated_starts',
              `${streak} consecutive sentences start with "${starts[i]}". Vary your sentence openings to improve flow.`,
              sentences[i - 2]?.slice(0, 80)
            );
            break;
          }
        } else {
          streak = 1;
        }
      }
    }

    /* word_repetition — temporarily disabled
    const contentWords = trimmed.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? [];
    const freq = /** @type {Record<string,number>} *\/ ({});
    for (const w of contentWords) freq[w] = (freq[w] ?? 0) + 1;
    for (const [w, n] of Object.entries(freq)) {
      if (n >= 4) {
        add(
          'word_repetition',
          `"${w}" appears ${n} times in this paragraph. Consider varying your word choice.`,
          trimmed.slice(0, 80)
        );
      }
    }
    */
  }

  return suggestions;
}
