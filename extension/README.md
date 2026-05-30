# FocusLens

A privacy-first Chrome extension that uses a **local** vision-language LLM
(Qwen3-VL via [LM Studio](https://lmstudio.ai)) to keep you accountable to
a focus goal. Nothing leaves your machine.

---

## How it works

1. You set a **goal** (e.g. *"Learn how transformers work"*) and a **planned duration**.
2. While the session is active, FocusLens watches tab switches and time spent per page,
   extracts page text/title/metadata (and a screenshot for video pages or text-light pages),
   then asks your local LM Studio model:
   *"Is this activity pro-goal or anti-goal? What's the weight (-1.0 → 1.0)?"*
3. The model's response moves a **red ↔ green focus pointer** that floats in the
   top-right corner of every page. Hits **+100** → 🎉 congrats popup. Hits **-100** →
   ⚠️ alert popup. Either way you'll be asked to set a new goal.

All data is stored in `chrome.storage.local`. The only network call is to
`http://127.0.0.1:1234/v1/chat/completions`.

---

## Prerequisites

- Chrome / Edge / Brave (any Chromium browser, MV3 support)
- [LM Studio](https://lmstudio.ai) running locally with:
  - Model loaded: **`qwen/qwen3-vl-4b`** (or any vision-language model — see config note below)
  - Local server started (default `http://127.0.0.1:1234`)
  - **CORS enabled** in *Server → Settings → "Enable CORS"*

---

## Install (unpacked)

1. Clone or download this folder (`/app/extension`).
2. Visit `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** → select the `extension/` folder.
5. Pin the *FocusLens* icon in the toolbar.

---

## Usage

1. Start LM Studio → load `qwen/qwen3-vl-4b` → start the local server → enable CORS.
2. Click the FocusLens icon.
3. Enter your **goal** and pick a **planned time** (or use Custom for any minute value).
4. Click **Start Focus**.
5. Browse normally. The floating focus scale will appear on each page update and
   fade out after 5 seconds.
6. Click **Stop Focus** anytime to see your session summary (final score,
   pro/anti activity counts, top sites by time spent).

You can change the model identifier or the LM Studio URL in `background.js`
(constants `MODEL_NAME` and `LM_STUDIO_URL`).

---

## Files

```
extension/
├── manifest.json    Manifest V3 declaration
├── popup.html       Popup markup
├── popup.css        Popup styles (dark theme)
├── popup.js         Popup logic (start / stop / reset / live stats)
├── background.js    Service worker: tab tracking + LM Studio calls + scoring
├── content.js       Page extraction + floating focus-scale overlay + modals
├── content.css      Overlay & modal styles (glass-morphism, scoped IDs)
├── icons/           Toolbar icons (16/48/128 px)
└── test.html        Local demo page — load it to see the overlay & modals
```

---

## Test page

Open `test.html` directly in Chrome (`file://...`) **with the extension installed**
to verify the overlay renders correctly without needing LM Studio. Buttons on
that page simulate score updates and end-state modals.

---

## Tuning

| Constant                   | File           | Default | Notes |
| -------------------------- | -------------- | ------- | ----- |
| `LM_STUDIO_URL`            | background.js  | `http://127.0.0.1:1234/v1/chat/completions` | LM Studio endpoint |
| `MODEL_NAME`               | background.js  | `qwen/qwen3-vl-4b` | Must match a loaded model |
| `DEBOUNCE_MS`              | background.js  | 10000   | Min interval between LLM calls |
| `SAME_PAGE_THRESHOLD_MS`   | background.js  | 30000   | Re-evaluate same page every N ms |
| `SCORE_SCALING`            | background.js  | 15      | `score += weight × scaling` |

---

## Troubleshooting

- **"LM Studio not reachable" in popup** — confirm the LM Studio server is running,
  CORS is enabled, and you can hit `http://127.0.0.1:1234/v1/models` from a terminal.
- **Overlay missing on a page** — Chrome doesn't inject content scripts on
  `chrome://`, the Chrome Web Store, or PDF viewers.
- **No score movement** — the debounce is 10 s. Try switching tabs / waiting
  30 s on a page to trigger a re-evaluation.
- **Bad JSON from the model** — the system prompt asks for strict JSON; small
  models occasionally drift. We extract the first `{ ... }` block from the
  response, but if your model consistently fails, raise `temperature` or use a
  larger Qwen variant.

---

## Privacy

FocusLens makes **zero** external network calls. Everything (goal text, page
content, screenshots, scores) lives in `chrome.storage.local` and in the
fetch to your local LM Studio instance. You can audit `background.js` —
the only `fetch` call points at `127.0.0.1`.
