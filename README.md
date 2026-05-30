# FocusLens

A privacy-first Chrome extension that uses a local Qwen3-VL model (via LM Studio)
to keep you accountable to a focus goal. Nothing leaves your machine.

The entire project lives in [`extension/`](./extension/) — vanilla HTML/CSS/JS,
no build tools, loads directly via Chrome's *Load unpacked* developer flow.

See [`extension/README.md`](./extension/README.md) for install, usage,
configuration constants, and troubleshooting.

```
.
├── extension/        ← The Chrome extension (load this as an unpacked extension)
│   ├── manifest.json
│   ├── popup.html / popup.css / popup.js
│   ├── background.js
│   ├── content.js / content.css
│   ├── icons/        (16 / 48 / 128 px)
│   ├── test.html     ← Offline demo page for overlay & modals
│   └── README.md
└── memory/PRD.md     ← Product requirements & implementation log
```
