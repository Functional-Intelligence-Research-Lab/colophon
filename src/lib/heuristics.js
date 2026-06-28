/**
 * heuristics.js — Grammarly-style lightweight local text analysis
 *
 * Pure synchronous analysis, no network, no AI inference.
 * Returns an array of suggestion objects ready to be emitted as
 * 'heuristic_suggestion' events in the timeline.
 */

// ── Readability (Flesch-Kincaid Reading Ease) ──────────────────────────────────

function syllableCount(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  const groups = word.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (word.length > 2 && word.endsWith('e')) n = Math.max(1, n - 1);
  return Math.max(1, n);
}

function fleschReadingEase(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
  const words = text.match(/\b[a-zA-Z']+\b/g) ?? [];
  if (sentences.length === 0 || words.length < 10) return null;
  const sylls = words.reduce((n, w) => n + syllableCount(w), 0);
  return 206.835
    - 1.015  * (words.length / sentences.length)
    - 84.6   * (sylls / words.length);
}

function readabilityLabel(score) {
  if (score >= 70) return null; // Standard or easier — no tip needed
  if (score >= 50) return `Readability score: ${score.toFixed(0)}/100 (fairly difficult). Consider using shorter sentences and simpler words.`;
  if (score >= 30) return `Readability score: ${score.toFixed(0)}/100 (difficult). Your writing may be hard to follow — aim for shorter sentences.`;
  return `Readability score: ${score.toFixed(0)}/100 (very difficult). Most readers will struggle with this text. Try breaking it into simpler sentences.`;
}

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
      suggestions.push({ rule, text: tipText, excerpt: excerpt.trim().slice(0, 100) });
    }
  };

  // ── 1. Readability score (whole document) ──────────────────────────────────
  const score = fleschReadingEase(text);
  if (score !== null) {
    const label = readabilityLabel(score);
    if (label) add('readability', label, '');
  }

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

    // 3. Long paragraph
    if (paraWords.length > 350) {
      add(
        'long_paragraph',
        `Very long paragraph (${paraWords.length} words). Consider splitting it into sections.`,
        trimmed.slice(0, 80)
      );
    }

    // 4. Passive voice
    const passiveMatches = trimmed.match(PASSIVE_RE) ?? [];
    if (passiveMatches.length >= 2) {
      const excerpt = passiveMatches.slice(0, 2).join(', ');
      add(
        'passive_voice',
        `Passive voice detected ${passiveMatches.length} time${passiveMatches.length > 1 ? 's' : ''} in this paragraph (e.g. "${excerpt}"). Consider rewriting in active voice.`,
        trimmed.slice(0, 80)
      );
    }

    // 5. Weak/filler words
    const lowerPara = trimmed.toLowerCase();
    const foundWeak = [...WEAK_WORDS].filter(w => lowerPara.includes(w));
    if (foundWeak.length >= 2) {
      add(
        'filler_words',
        `Weak filler words found: ${foundWeak.slice(0, 4).map(w => `"${w}"`).join(', ')}. Try removing or replacing them for a stronger voice.`,
        trimmed.slice(0, 80)
      );
    }

    // 6. Wordy phrases
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

    // ── Per-sentence checks ────────────────────────────────────────────────
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);

    // 7. Long sentences
    for (const s of sentences) {
      const wc = s.split(/\s+/).length;
      if (wc > 30) {
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

    // 9. Repeated content words within paragraph
    const contentWords = trimmed.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? [];
    const freq = /** @type {Record<string,number>} */ ({});
    for (const w of contentWords) freq[w] = (freq[w] ?? 0) + 1;
    for (const [w, n] of Object.entries(freq)) {
      if (n >= 3) {
        add(
          'word_repetition',
          `"${w}" appears ${n} times in this paragraph. Consider varying your word choice.`,
          trimmed.slice(0, 80)
        );
      }
    }
  }

  return suggestions;
}
