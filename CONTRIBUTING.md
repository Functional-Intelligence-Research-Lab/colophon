# Contributing to Colophon

Colophon is the browser extension for [TWFF](https://github.com/Functional-Intelligence-Research-Lab/twff) — the Tracked Writing File Format. It records AI writing interactions as a transparent, author-controlled process log.

This extension is what we are building. Read the spec before writing code.

---

## Before you write a line of code

1. **Read the TWFF spec** at the link above. Specifically: the `process-log.json` schema and the eight event types.
2. **Run Glass Box** at [demo.firl.nl](https://demo.firl.nl), write two paragraphs, invoke an AI suggestion, export a `.twff` file, open the JSON.
3. **Post in #dev** on Discord: paste the `ai_interaction` block from your exported file. This confirms you understand what you are building toward.

Do not skip step 3. It is not optional.

---

## Workflow

All work happens through GitHub Issues and Pull Requests.

- Pick up an issue from the project board. Assign it to yourself.
- Create a branch: `feat/short-description` or `fix/short-description`
- Open a **draft PR** within 24 hours of starting — even if empty. This makes work visible.
- Move the PR out of draft when it is ready for review.
- Every PR must close at least one issue: add `Closes #N` to the PR description.

No direct commits to `main`. No exceptions.

---

## Pull request checklist

Before requesting review, confirm:

- [ ] The change does exactly what the linked issue describes and nothing else
- [ ] Tested
- [ ] The exported `.twff` file still validates against the TWFF spec (run `python validate.py your-file.twff`)
- [ ] No data leaves the browser (verify with DevTools → Network tab)
- [ ] PR description includes the AI use note below

---

## AI tool use policy

You may use AI coding assistants. The following rules are not negotiable.

**You must be able to explain every line of code you commit, if asked.**

Each PR description must include one of:

```
AI tools: none
```
or
```
AI tools: used for [specific purpose — e.g. unit test boilerplate, regex generation].
Reviewed and modified before commit.
```

AI-generated code that you cannot explain, that introduces security issues, or that uses licences incompatible with Apache-2.0 will cause the PR to be rejected.

This policy is not bureaucracy. Colophon is a tool for AI transparency in writing. Submitting code you do not understand to this repo is a contradiction in terms.

---

## Code style

- JavaScript / TypeScript: follow the ESLint config in the repo. Run `npm run lint` before pushing.
- No external dependencies added without discussion in the relevant issue first.
- Keep the manifest permissions minimal. Every permission request is a user trust question.

---

## Commit messages

Plain English, present tense, one line:

```
Add SHA-256 hash chain to session export
Fix popup not rendering on Firefox 115
Update ai_interaction schema to include modelVersion field
```

No "WIP", no "fix stuff", no emoji-only commits.

---

## Reporting bugs

Open an issue with the **Bug report** template. Include:
- Browser and version
- Steps to reproduce
- What you expected vs what happened
- The exported `.twff` file if relevant (remove any personal content first)

---

## Licence

By contributing, you agree that your work is released under the [Apache-2.0 licence](LICENSE), consistent with the rest of the TWFF project.

Your contributions will be credited in the repository and in any publications that use Colophon as a research instrument.
