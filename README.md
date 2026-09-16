# Light Novel Translator

![License](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-early%20%2F%20active-yellow)
![Stack](https://img.shields.io/badge/stack-vanilla%20JS%2C%20no%20build%20step-informational)
![Backend](https://img.shields.io/badge/backend-none%20%2F%20local--first-success)
![Powered by](https://img.shields.io/badge/powered%20by-Ollama-black)

A local-first, browser-based tool for translating long-form fiction (light
novels, web novels, or any long narrative text) with a self-hosted
[Ollama](https://ollama.com) model — while actually keeping track of who's
who, how they talk to each other, and what things mean.

Line-by-line machine translation of a 300+ page novel loses names,
relationship nuance, and consistent handling of slang, honorifics, and
euphemisms across chapters. This tool fixes that by reading the whole book
first, building an editable **story bible** (characters, relationships,
locations, terminology) and a **whole-novel synthesis** (plot arc, tone,
foreshadowing) grounded in quoted evidence from the actual text — then uses
both as context for every translation call.

> **Status:** early, actively evolving. Built for personal use against a
> real novel; expect rough edges.

---

## Why this exists

- **Context survives chapter boundaries.** A name, an in-joke, or a running
  euphemism introduced in chapter 3 is still known and used consistently in
  chapter 40.
- **You can see *why* the model believes something.** Every bible entry is
  backed by a verbatim quote from the source text, checked programmatically
  against that quote — entries that can't be verified are flagged, not
  hidden.
- **Nothing leaves your machine.** No backend, no server-side storage, no
  cloud LLM calls. The page talks directly to your own local Ollama.
- **You're in control of the model.** Bring whatever Ollama model fits your
  hardware and content — the app doesn't filter, censor, or second-guess
  your choice.

## How it works

```
raw .txt
   │  auto-detect chapter boundaries (editable before committing)
   ▼
Extraction  ──  each chapter (or auto-batched group of chapters) is read
   │             INDEPENDENTLY — no running state is fed back in, so one
   │             bad guess can never compound into the next chapter's
   │             analysis. Every character/location/term comes with a
   │             quoted excerpt, verified against the source text.
   ▼
Story Bible ──  review/edit/approve names, relationships, terminology;
   │             merge likely-duplicate entries by hand.
   ▼
Synthesis   ──  a whole-novel synopsis, character arcs, tone notes, and
   │             foreshadowing map, built from the bible's per-chapter
   │             summaries (not by re-reading raw text).
   ▼
Translation ──  each chapter (auto-batched to fill your context window)
   │             is translated using the full bible + synthesis as context.
   ▼
Review & Export ── spot-check/edit any chapter, export a ready-to-read
                    .epub, built entirely in your browser.
```

## Features

- 📖 **Chapter-aware import** — auto-detects chapter breaks (including
  full-width/CJK numbering like `１．`), with a manual fix-up UI.
- 🧠 **Grounded extraction** — every fact requires a verbatim source quote;
  quotes are checked in code, not just trusted from the model.
- 🔗 **Story bible** — characters, relationships, locations, terminology,
  and a per-chapter timeline, all editable.
- 🧩 **Duplicate detection** — flags likely name variants for manual review
  (never auto-merged).
- 📝 **Whole-novel synthesis** — plot arc, character development, tone, and
  foreshadowing, generated from the bible without re-reading raw text.
- 📦 **Auto-batching** — packs as many chapters as fit your configured
  context budget into one call, improving cross-chapter consistency and
  cutting round-trips.
- 📊 **Token visibility** — estimated and actual (Ollama-reported) token
  usage per call, so you can tell whether your context window is enough.
- 📚 **Client-side EPUB export** — no server round-trip.
- 💾 **Local-only storage** — IndexedDB, with JSON export/import for backup
  or moving between machines.
- 🧹 **One-click resets** — reset settings or wipe a project's data from a
  corner widget on every page.

## Getting started

### Requirements

- [Ollama](https://ollama.com), running locally with a model pulled.
- Python (for the simplest local static server) — or any static file host.
- A Chromium-based browser is recommended.

### Run it

```bash
git clone <this-repo>
cd light-novel-translator
./run.bat        # Windows: starts a static server and opens the app
```

Or manually:

```bash
python -m http.server 8099
# then open http://localhost:8099
```

### Configure Ollama for browser access

The browser calls Ollama's API directly (no backend in between), so Ollama
must allow this page's origin via CORS:

```bash
OLLAMA_ORIGINS=http://localhost:8099 ollama serve
```

On Windows, set `OLLAMA_ORIGINS` as an environment variable before starting
Ollama. If you serve the app from a different port/host, update this to
match.

### First run

1. Open the app, go to **Settings**, set your Ollama host, model name
   (use "Detect installed models" to confirm connectivity), source/target
   language, and context budget (match whatever context size you've
   configured in Ollama).
2. **Import** a `.txt` file, check the detected chapter boundaries.
3. Run **extraction**, review the **Story Bible**, generate a **synthesis**.
4. Run **translation**, spot-check chapters, **export** the `.epub`.

## Settings reference

| Setting | Purpose |
|---|---|
| Ollama host | Where the browser sends requests (default `http://localhost:11434`) |
| Model | Exact Ollama model name/tag to use for every call |
| Source / target language | Interpolated into every prompt — not hardcoded to any language pair |
| Context budget | *Comparison only* — never sent to Ollama. Set it to whatever context size you've actually configured, so token estimates can warn you when a call would exceed it |
| Batch fill target (%) | How much of the context budget to pack per call when auto-batching chapters (default 80%) |

## Project structure

```
index.html            entry point, no build step
css/style.css          all styling
js/
  app.js               router / view switching
  storage.js           IndexedDB wrapper, project export/import, resets
  ollama.js            direct browser → Ollama client (streaming)
  splitter.js          chapter-boundary detection
  prompts.js           every prompt sent to the model, in one place
  extraction.js        grounded per-batch story-bible extraction + merge
  synthesis.js         whole-novel synthesis from bible timeline entries
  translation.js       batched translation + marker-based chapter splitting
  batching.js          shared token-budget batch packing
  grouping.js          multi-chapter marker join/split for batched calls
  verify.js            quote verification + duplicate-entity detection
  tokens.js            heuristic token estimation
  epub.js              client-side EPUB generation (JSZip)
  ui/                  one file per view (import, bible, translate, export, settings, reset corner)
vendor/jszip.min.js    vendored dependency (no external CDN at runtime)
```

## Data & privacy

Everything — source text, story bible, translations, settings — lives in
your browser's IndexedDB. Nothing is sent anywhere except your own Ollama
instance. Use **Export project (.json)** in Settings for a portable backup,
and **Import** to restore it (on this machine or another).

## Known limitations

- Token estimates are heuristic (character-class based), not a real
  tokenizer for your specific model — treat them as ballpark, not exact.
- Very long individual chapters that alone exceed your context budget still
  run as a single (over-budget) call rather than being split further.
- No automated test suite yet; changes are verified manually against a
  real novel and small synthetic fixtures during development.

## License

MIT — see [LICENSE](LICENSE).
