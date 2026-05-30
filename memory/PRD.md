# FocusLens — Chrome Extension PRD

## Original Problem Statement
Build a Chrome Extension (Manifest V3) called "FocusLens" — a privacy-first AI focus
tracker. User sets a focus goal + planned time; the extension tracks active tab URL,
extracts page text/title/metadata, periodically captures screenshots, sends context
to a local LM Studio server (Qwen3-VL-4B at http://127.0.0.1:1234/v1/chat/completions,
OpenAI-compatible). The LLM returns `{classification, weight, reason}`; the extension
maintains a -100..+100 focus score and renders a red→green focus scale overlay on
every page. Hitting +100 → congrats modal; hitting -100 → alert modal. After either
end-state the user must set a new goal.

## User Choices (confirmed)
- Vanilla HTML/CSS/JS (no build tools)
- Output folder: `/app/extension`
- Model id: `qwen/qwen3-vl-4b`
- Include placeholder PNG icons (16/48/128)
- Include README.md + test.html demo page

## Architecture
| Layer | File |
| --- | --- |
| Manifest v3 | manifest.json |
| Popup UI | popup.html / popup.css / popup.js |
| Service worker | background.js — tab tracking, LM Studio fetch, scoring, alarms |
| Content script | content.js — page extraction + overlay + end modals |
| Overlay styles | content.css (scoped to `#focuslens-overlay`, `#focuslens-modal`) |
| Storage | `chrome.storage.local.session` |
| Icons | icons/icon{16,48,128}.png |
| Demo | test.html (open with `file://` to verify overlay without LM Studio) |

## User Personas
- **P0** Tech-savvy knowledge workers doing deep work
- **P0** Students/researchers running long focus sessions
- **P1** Anyone with focus/productivity goals

## Implemented (Feb 2026)
- Manifest V3 with required perms (activeTab, tabs, storage, scripting) and host perms for local LM Studio + `<all_urls>`.
- Popup UI: dark theme, goal textarea, time selector with custom option, live score / elapsed / pro-anti counts, summary card with top sites, error card.
- Background service worker:
  - Session lifecycle (start / stop / reset) persisted in `chrome.storage.local`.
  - Tab tracking via `chrome.tabs.onActivated` + `onUpdated`.
  - Per-domain time accumulation; flushed on tab change & session stop.
  - 10s global debounce + `chrome.alarms` tick for 30s same-page re-evaluations.
  - Builds OpenAI-compatible chat payload (text-only OR vision with base64 jpeg via `chrome.tabs.captureVisibleTab`).
  - Robust JSON parser (strips ``` fences, extracts first `{}` block) and clamps weight to [-1,1].
  - Score update: `score += weight × 15`, clamped to [-100, +100]; ends session and broadcasts end-state when bounds hit.
  - Error capture with friendly LM-Studio reachability message surfaced in popup.
- Content script:
  - Page text extraction (innerText, 2000 char cap) + meta description.
  - Video detection (YouTube watch / Vimeo / Twitch / any `<video>`).
  - YouTube-specific extraction of title, channel, description.
  - Floating glass-morphism overlay (top-right, z-index max int) with red→yellow→green gradient bar, animated pointer, score readout, last-reason tag, auto fade after 5s.
  - End-state modal (congrats / alert) with backdrop + dismiss button.
- Icons generated via Pillow (target/crosshair design, 16/48/128).
- README with install, troubleshooting, tuning constants and privacy notes.
- Standalone `test.html` demo page for offline verification of overlay & modals.

## Backlog (P1/P2)
- P1: Pause/Resume controls (without losing session state).
- P1: Per-session history (multiple sessions stored, browsable).
- P1: Optional notification when score crosses configurable thresholds (e.g., -50).
- P2: Allowlist/blocklist domains to skip from classification.
- P2: Custom LM Studio URL / model id editable from popup (currently constants).
- P2: Export session JSON / CSV.
- P2: Light theme + accessibility audit.

## Testing Notes
- Cannot run `testing_agent_v3` against a Chrome extension (no Playwright extension load in our env). Manual testing path: load unpacked in Chrome dev mode + open `test.html` to validate overlay behavior; verify LM Studio integration end-to-end against a live local server.
- Static checks passed: `manifest.json` valid, `background.js` / `popup.js` / `content.js` parse cleanly with `node -c`.

## Next Action Items
- User loads the unpacked extension in Chrome dev mode and points it at LM Studio with `qwen/qwen3-vl-4b` (CORS enabled).
- If model returns malformed JSON consistently, lower `temperature` or upgrade to a larger Qwen3-VL variant.
- Tune `SCORE_SCALING` (default 15) if sessions feel too short/long to reach ±100.
