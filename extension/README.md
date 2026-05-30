# FocusLens

A privacy-first Chrome extension that uses a **local** vision-language LLM
(Qwen3-VL via [LM Studio](https://lmstudio.ai)) to keep you accountable to
a focus goal. Nothing leaves your machine.

---

## How it works

1. **Configure your local LLM server** (one-time): open the popup, pick a provider
   (LM Studio / Ollama / llama.cpp / Custom), set the base URL, click
   **Test connection** to fetch the model list, pick a model, hit **Save**.
2. You set a **goal** (e.g. *"Learn how transformers work"*) and a **planned duration**.
3. While the session is active, FocusLens watches tab switches and time spent per page,
   extracts page text/title/metadata (and a screenshot for video pages or text-light pages),
   then asks your local server's OpenAI-compatible endpoint:
   *"Is this activity pro-goal or anti-goal? What's the weight (-1.0 → 1.0)?"*
4. The model's response moves a **red ↔ green focus pointer** that floats in the
   top-right corner of every page. Hits **+100** → 🎉 congrats popup. Hits **-100** →
   ⚠️ alert popup. Either way you'll be asked to set a new goal.

All data is stored in `chrome.storage.local`. The only network call is to
`http://127.0.0.1:1234/v1/chat/completions`.

---

## Prerequisites

- Chrome / Edge / Brave (any Chromium browser, MV3 support)
- A local **OpenAI-compatible** LLM server. Tested with:
  - **LM Studio** (default port `1234`) — load a Qwen3-VL or any other model, start the server, *enable CORS* in Server settings.
  - **Ollama** (default port `11434`) — run `ollama serve`; OpenAI-compatible endpoints are on by default.
  - **llama.cpp** server / **vLLM** / any server that implements `/v1/models` and `/v1/chat/completions`.
- For vision-based classification (recommended for video pages), use a vision-capable
  model such as `qwen/qwen3-vl-4b`. Text-only models still work for everything else.

---

## Install (unpacked)

1. Clone or download this folder (`/app/extension`).
2. Visit `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** → select the `extension/` folder.
5. Pin the *FocusLens* icon in the toolbar.

---

## Usage

1. Start your local LLM server (LM Studio / Ollama / etc.). Make sure CORS is
   enabled if your server requires it.
2. Click the FocusLens icon.
3. **First time only** — the LLM server card auto-expands. Pick a provider preset
   (or **Custom**), edit the base URL if needed, click **Test connection** to
   fetch available models, choose one, click **Save server**.
4. Enter your **goal** and pick a **planned time** (or use Custom for any minute value).
5. Click **Start Focus**.
6. Browse normally. The floating focus scale will appear on each page update and
   fade out after 5 seconds.
7. Click **Stop Focus** anytime to see your session summary (final score,
   pro/anti activity counts, top sites by time spent).

You can change the server / model at any time from the popup (click **Edit** next
to the server pill). The choice persists in `chrome.storage.local.llmSettings`.

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

LLM server choice (provider, base URL, model) is **set from the popup UI** — no
code changes needed. The constants below are evaluation-pipeline knobs in
`background.js`:

| Constant                   | Default | Notes |
| -------------------------- | ------- | ----- |
| `DEFAULT_LLM_SETTINGS`     | LM Studio · `http://127.0.0.1:1234` · `qwen/qwen3-vl-4b` | Fallback used on first install before the user configures the popup. |
| `DEBOUNCE_MS`              | 10000   | Min interval between LLM calls. |
| `SAME_PAGE_THRESHOLD_MS`   | 30000   | Re-evaluate same page every N ms. |
| `SCORE_SCALING`            | 15      | `score += weight × scaling`. |

---

## Troubleshooting

- **"Configure LLM server" pill won't go away** — click *Edit*, paste your server's
  base URL, click *Test connection*. If Test fails, your server isn't reachable
  from the browser. Confirm `curl http://<your-url>/v1/models` works in a terminal.
- **Test connection fails with CORS error** — enable CORS in your LLM server
  settings (LM Studio: *Server → Settings → Enable CORS*; Ollama: usually open by
  default).
- **Overlay missing on a page** — Chrome doesn't inject content scripts on
  `chrome://`, the Chrome Web Store, or PDF viewers.
- **No score movement** — the debounce is 10 s. Try switching tabs / waiting
  30 s on a page to trigger a re-evaluation.
- **Bad JSON from the model** — the system prompt asks for strict JSON; small
  models occasionally drift. We extract the first `{ ... }` block from the
  response. If your model consistently fails, lower `temperature` or pick a
  larger / instruction-tuned variant.

---

## Privacy

FocusLens makes **zero** external network calls. Everything (goal text, page
content, screenshots, scores) lives in `chrome.storage.local` and in the
fetch to your local LM Studio instance. You can audit `background.js` —
the only `fetch` call points at `127.0.0.1`.
