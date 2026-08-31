# Colophon

A Chrome extension that records AI writing interactions alongside Google Docs as a
TWFF-compatible process log: what was written, when AI assistance was used, and what the
author decided to do with each suggestion (accept, modify, or reject). The author exports
and submits the log voluntarily; nothing is sent anywhere automatically.

Full format specification: [TWFF spec](https://github.com/Functional-Intelligence-Research-Lab/twff)
Live demo of the desktop editor: [firl.nl/twff](https://firl.nl/twff)

---

## What it does

- Records a writing session in Google Docs: edits, pastes, and AI-assisted text, each
  tagged with how it entered the document.
- Optionally runs local AI writing assistance (paraphrase, grammar, brainstorm) entirely on
  your own machine via a companion program: no cloud API, no data leaving your computer. This
  is off by default and fully optional.
- Lightweight writing-quality heuristics (long sentences, filler words, repetition) surface as
  suggestions in the side panel. This is a secondary feature, not a replacement for a
  dedicated grammar checker.
- Exports the recorded session as a `.twff` file (a structured, human- and
  machine-readable process log) that can be opened in this extension's own viewer or at
  [colophon.firl.nl/viewer](https://colophon.firl.nl/viewer).

**What it keeps**: character counts and edit positions (not your typed keystrokes), paste
event metadata (character count and source), AI interaction type/model/acceptance decision,
and session timestamps. Never your full document text, never individual keystrokes, and
nothing is sent to any server unless you explicitly export and share the file yourself.

## Installing

Live on the Chrome Web Store: [Colophon](https://chromewebstore.google.com/detail/colophon/manpdfemofccpcppkiepppbineggdnka).
For local development, build from source (see below) and load it as an unpacked extension instead.

---

## Getting started (development)

```bash
git clone https://github.com/Functional-Intelligence-Research-Lab/colophon
cd colophon
npm install
npm run build        # produces dist/
```

Load unpacked extension in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

During development, use `npm run watch` instead of `npm run build`; it rebuilds on every save. Reload the extension in `chrome://extensions` after each rebuild.

To validate a `.twff` export:

```bash
python tools/validate.py path/to/your-session.twff
```

---

## Before contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licence

Apache-2.0. See [LICENSE](LICENSE).

Contributions are credited in the repository and in any publications using Colophon as a research instrument.
