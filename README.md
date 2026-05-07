# Colophon

Colophon runs in Chrome and Firefox alongside Google Docs. It records AI writing interactions as a TWFF-compatible process log: what was written, when AI assistance was used, and what the author decided to do with each suggestion (accept, modify, or reject). The author exports and submits the log voluntarily.

The `.twff` file is a structured JSON log that shows the writing process

Full format specification: [TWFF spec](https://github.com/Functional-Intelligence-Research-Lab/twff)
Live demo of the desktop editor: [firl.nl/twff](https://firl.nl/twff)

---

## Roadmap

### Sprint 1: In progress (Apr 27 – May 10)

- [ ] [#1](https://github.com/Functional-Intelligence-Research-Lab/colophon/issues/2) Manifest V3 scaffold
- [ ] [#2](https://github.com/Functional-Intelligence-Research-Lab/colophon/issues/20) Session lifecycle
- [ ] [#3](https://github.com/Functional-Intelligence-Research-Lab/colophon/issues/21) Edit event capture
- [ ] [#4](https://github.com/Functional-Intelligence-Research-Lab/colophon/issues/22) Popup UI
- [ ] [#5](https://github.com/Functional-Intelligence-Research-Lab/colophon/issues/23) Local JSON export → `.twff`

### Sprint 2: {AI Path A} (May 11 – May 24)

- Ollama integration: *[llamafile](https://github.com/Mozilla-Ocho/llamafile) should also be tested as alternative*
- Side panel scaffold
- `ai_interaction` event schema
- SHA-256 hash chain for integrity verification

<!-- - [ ] Ollama API integration (`localhost:11434`; model selector populated from `/api/tags`) -->

### Sprint 3: AI Path B  (May 25 – Jun 7)

- Detect Gemini native suggestions in Google Docs DOM
- Gemini API test
- Google Drive save option
- Chrome Web Store setup

### Sprint 4: internal beta (Jun 8 – Jun 21)

- Settings page
- Side panel polish
- Internal beta

### Sprint 5 — Release (Jun 22 – Jul 5)

- Chrome Web Store submission
- User-facing README: install, first use, privacy, TWFF export

### Milestone tracker

| Milestone | Target date | Status | Output | Actual date |
|---|---|---|---|---|
| Sprint 1 complete | May 10 | [in progress] | Extension can produce a valid .twff export | |
| Sprint 2 complete | May 24 | [ ] | Ollama ai_interaction recorded | |
| Sprint 3 complete | Jun 7 | [ ] | Gemini detected; Drive save working | |
| Internal beta | Jun 14 | [ ] | test, no critical bugs | |
| Store submission | Jul 5 | [ ] | Passing Chrome review | |
| Case study beta | Jul 2025 | [ ] | Deployed at uni site | |

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

During development, use `npm run watch` instead of `npm run build` — it rebuilds on every save. Reload the extension in `chrome://extensions` after each rebuild.

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
