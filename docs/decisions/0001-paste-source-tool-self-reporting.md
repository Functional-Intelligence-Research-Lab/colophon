# Decision Record: Paste Source Tool Self-Reporting Tag

**Status:** Accepted  
**Date:** 2026-10-15  
**Context:** Cross-tool AI usage observation via lightweight self-reporting at paste time  

## Context and Problem Statement

When a student uses AI tools outside of Google Docs (such as ChatGPT, Claude, Copilot, Perplexity, or DeepSeek) and pastes the output into their document, the paste is recorded by Colophon as an ordinary external clipboard paste. As a result, cross-tool AI usage cannot be distinguished from ordinary web citations or text movement without inferring or guessing.

Inferring AI tools automatically through heuristics or detection violates Colophon's foundational philosophy (*"A research instrument, not a scoring tool"*). Automated detectors are unreliable, adversarial, and prone to false accusations.

Instead, a lightweight self-report mechanism gives students the agency to truthfully tag the origin tool of a paste at or shortly after paste time, providing researchers and teachers with verified self-reported empirical data.

## Deliverables & Specifications

### 1. Data Model (`source_tool`)
- An optional `source_tool` string field is added to paste event `meta` (`event.meta.source_tool`).
- Allowed values are constrained to a fixed set:
  - `chatgpt`: "ChatGPT"
  - `claude`: "Claude"
  - `copilot`: "Microsoft Copilot"
  - `gemini`: "Gemini"
  - `perplexity`: "Perplexity"
  - `deepseek`: "DeepSeek"
  - `other_ai`: "Other AI"
  - `not_ai`: "Not AI-generated"

### 2. Interaction Flow
- When an external paste is recorded, a lightweight floating prompt appears near the bottom corner of Google Docs.
- The prompt is non-blocking: keyboard focus remains in the document, allowing students to type uninterrupted.
- Quick chips enable one-click selection of the tool.
- A confirmation ("✓ Recorded self-report: ...") provides instant feedback before the prompt slides away.

### 3. Decision on Skipped Tagging (Deliverable 5)

**Decision:** When a student skips tagging (by clicking the "✕" dismiss button, or ignoring the prompt until it auto-dismisses after 10 seconds), the `source_tool` field is **left omitted** (`undefined` in JavaScript, absent from the serialized JSON `meta` object).

**Rationale:**
1. **Semantic Accuracy:** An omitted field unambiguously represents *"no self-report provided"* (an untagged paste). Defaulting to `'not_ai'` would create false negatives, while defaulting to an AI tool or `'other_ai'` would fabricate false positives.
2. **Backward Compatibility:** Omitting `source_tool` on untagged pastes ensures complete backward compatibility with all historical `.twff` files and sessions.
3. **Storage & Hash Cleanliness:** It avoids bloating the process-log with redundant `'unspecified'` keys for ordinary edits and typing pastes.
4. **Research Utility:** In research queries, `source_tool IS NOT NULL` isolates confirmed self-reports, whereas `source_tool IS NULL` cleanly denotes unclassified pastes.

### 4. Honest Labeling Requirement
In accordance with Colophon ethics guidelines, the tag must always be explicitly labeled as **self-reported** (e.g. `Self-reported source: ChatGPT`), and never described or implied as "detected", "flagged", or "AI-detected".

