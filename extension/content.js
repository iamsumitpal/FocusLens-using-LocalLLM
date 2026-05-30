// content.js — FocusLens content script: page extraction + focus scale overlay

(function () {
  if (window.__focusLensInjected) return;
  window.__focusLensInjected = true;

  // ------------- extraction -------------
  function detectContentType() {
    const host = location.hostname;
    if (host.includes('youtube.com') && location.pathname.startsWith('/watch')) return 'video';
    if (host.includes('vimeo.com') || host.includes('twitch.tv')) return 'video';
    if (document.querySelector('video')) return 'video';
    return 'text';
  }

  function getMeta(name) {
    const m = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return m ? (m.getAttribute('content') || '').trim() : '';
  }

  function extractYouTubeMeta() {
    try {
      const title = (document.querySelector('h1.ytd-watch-metadata') ||
                     document.querySelector('h1.title') ||
                     document.querySelector('meta[name="title"]'))?.textContent
                  || document.title;
      const channel = (document.querySelector('ytd-channel-name a') ||
                       document.querySelector('#owner-name a') ||
                       document.querySelector('#text-container a'))?.textContent || '';
      const description = (document.querySelector('#description-inline-expander') ||
                           document.querySelector('#description'))?.innerText || getMeta('description');
      return { title: (title || '').trim(), channel: channel.trim(), description: (description || '').trim() };
    } catch { return null; }
  }

  function extractVideoMeta() {
    if (location.hostname.includes('youtube.com')) return extractYouTubeMeta();
    return {
      title: document.title || '',
      channel: '',
      description: getMeta('description') || getMeta('og:description') || '',
    };
  }

  function extractPagePayload() {
    const contentType = detectContentType();
    const title = (document.title || '').slice(0, 300);
    const desc = getMeta('description') || getMeta('og:description') || '';
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const text = desc ? `${desc}\n\n${bodyText}`.slice(0, 2000) : bodyText;

    const payload = { url: location.href, title, text, contentType };
    if (contentType === 'video') payload.videoMeta = extractVideoMeta();
    return payload;
  }

  // ------------- overlay UI -------------
  let overlay, scoreEl, pointerEl, reasonEl, fadeTimer, modalEl;

  function createOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'focuslens-overlay';
    overlay.setAttribute('data-testid', 'focuslens-overlay');
    overlay.innerHTML = `
      <div class="fl-card">
        <div class="fl-header">
          <div class="fl-logo"><span class="fl-dot"></span><span>FocusLens</span></div>
          <div class="fl-score" data-testid="focuslens-score">0</div>
        </div>
        <div class="fl-bar">
          <div class="fl-bar-track"></div>
          <div class="fl-pointer" data-testid="focuslens-pointer"></div>
          <div class="fl-tick fl-tick-min">-100</div>
          <div class="fl-tick fl-tick-zero">0</div>
          <div class="fl-tick fl-tick-max">+100</div>
        </div>
        <div class="fl-reason" data-testid="focuslens-reason"></div>
      </div>
    `;
    document.documentElement.appendChild(overlay);
    scoreEl   = overlay.querySelector('.fl-score');
    pointerEl = overlay.querySelector('.fl-pointer');
    reasonEl  = overlay.querySelector('.fl-reason');
    return overlay;
  }

  function showOverlayTemporarily() {
    if (!overlay) return;
    overlay.classList.add('fl-visible');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      overlay.classList.remove('fl-visible');
    }, 5000);
  }

  function updateOverlay({ score, reason, classification, silent }) {
    createOverlay();
    const clamped = Math.max(-100, Math.min(100, score || 0));
    const pct = ((clamped + 100) / 200) * 100;
    pointerEl.style.left = `${pct}%`;
    scoreEl.textContent = Math.round(clamped);
    scoreEl.classList.toggle('fl-positive', clamped > 0);
    scoreEl.classList.toggle('fl-negative', clamped < 0);
    if (reason) {
      reasonEl.style.display = 'block';
      const tag = classification === 'pro-goal' ? '✔ Pro-goal' : '✖ Anti-goal';
      reasonEl.innerHTML = `<span class="fl-tag fl-tag-${classification === 'pro-goal' ? 'pro' : 'anti'}">${tag}</span> ${escapeHtml(reason)}`;
    } else {
      reasonEl.style.display = reasonEl.textContent ? 'block' : 'none';
    }
    if (!silent) showOverlayTemporarily();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------- end-state modal -------------
  function showEndStateModal(endState, score) {
    if (modalEl) modalEl.remove();
    modalEl = document.createElement('div');
    modalEl.id = 'focuslens-modal';
    modalEl.setAttribute('data-testid', 'focuslens-modal');

    const isCongrats = endState === 'congrats';
    modalEl.innerHTML = `
      <div class="fl-modal-backdrop"></div>
      <div class="fl-modal-card ${isCongrats ? 'fl-modal-congrats' : 'fl-modal-alert'}">
        <div class="fl-modal-icon">${isCongrats ? '🎉' : '⚠️'}</div>
        <h2 class="fl-modal-title">${isCongrats ? 'Goal Achieved!' : 'Focus Lost'}</h2>
        <p class="fl-modal-body">${
          isCongrats
            ? 'Great focus session! You hit +100 — your activity strongly aligned with your goal.'
            : 'You\'ve drifted too far from your goal. Take a breath and set a new intention.'
        }</p>
        <div class="fl-modal-score">Final score: <strong>${Math.round(score)}</strong></div>
        <div class="fl-modal-hint">Open FocusLens to set a new goal.</div>
        <button class="fl-modal-btn" data-testid="focuslens-modal-dismiss">Dismiss</button>
      </div>
    `;
    document.documentElement.appendChild(modalEl);
    modalEl.querySelector('.fl-modal-btn').addEventListener('click', () => modalEl.remove());
    modalEl.querySelector('.fl-modal-backdrop').addEventListener('click', () => modalEl.remove());
  }

  // ------------- messaging -------------
  function sendPagePayload() {
    try {
      const payload = extractPagePayload();
      chrome.runtime.sendMessage({ type: 'PAGE_DATA', payload }).catch(() => {});
    } catch (e) {
      // ignore extraction errors
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'CAPTURE_PAGE': {
        sendPagePayload();
        sendResponse({ ok: true });
        break;
      }
      case 'FOCUS_UPDATE': {
        updateOverlay({
          score: msg.score,
          reason: msg.reason,
          classification: msg.classification,
          silent: !!msg.silent,
        });
        sendResponse({ ok: true });
        break;
      }
      case 'FOCUS_END': {
        showEndStateModal(msg.endState, msg.score);
        sendResponse({ ok: true });
        break;
      }
    }
    return true;
  });

  // Tell background we're ready; receive current score
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.session && resp.session.active) {
      updateOverlay({ score: resp.session.score || 0, silent: true });
      // Show briefly so user knows tracking is on
      showOverlayTemporarily();
    }
  });
})();
