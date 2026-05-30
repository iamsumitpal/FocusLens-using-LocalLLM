// popup.js — FocusLens popup controller

const $ = (id) => document.getElementById(id);

const els = {
  goalInput: $('goalInput'),
  timeInput: $('timeInput'),
  customTimeInput: $('customTimeInput'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  resetBtn: $('resetBtn'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  goalCard: $('goalCard'),
  liveCard: $('liveCard'),
  errorCard: $('errorCard'),
  errorBody: $('errorBody'),
  scoreValue: $('scoreValue'),
  scaleMiniPointer: $('scaleMiniPointer'),
  elapsedValue: $('elapsedValue'),
  activityCount: $('activityCount'),
  proCount: $('proCount'),
  antiCount: $('antiCount'),
  summaryCard: $('summaryCard'),
  finalScore: $('finalScore'),
  finalDuration: $('finalDuration'),
  finalPro: $('finalPro'),
  finalAnti: $('finalAnti'),
  topSitesList: $('topSitesList'),
};

let tickTimer = null;

// ---------- helpers ----------
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}m ${s}s`;
}

function scorePosition(score) {
  // map -100..100 to 0..100%
  const clamped = Math.max(-100, Math.min(100, score));
  return ((clamped + 100) / 200) * 100;
}

function setStatus(state, text) {
  els.statusPill.classList.remove('active', 'error', 'warn');
  if (state) els.statusPill.classList.add(state);
  els.statusText.textContent = text;
}

// ---------- render ----------
function renderSession(session) {
  const active = !!session && !!session.active;

  if (active) {
    els.goalCard.style.display = 'none';
    els.liveCard.style.display = 'flex';
    els.startBtn.style.display = 'none';
    els.stopBtn.style.display = 'block';
    setStatus('active', 'Focusing');

    const score = session.score || 0;
    els.scoreValue.textContent = Math.round(score);
    els.scaleMiniPointer.style.left = `${scorePosition(score)}%`;

    const startedAt = session.startedAt || Date.now();
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    els.elapsedValue.textContent = formatDuration(elapsed);

    const log = session.activityLog || [];
    els.activityCount.textContent = String(log.length);
    const pro = log.filter((a) => a.classification === 'pro-goal').length;
    const anti = log.filter((a) => a.classification === 'anti-goal').length;
    els.proCount.textContent = String(pro);
    els.antiCount.textContent = String(anti);
  } else {
    els.goalCard.style.display = 'block';
    els.liveCard.style.display = 'none';
    els.startBtn.style.display = 'block';
    els.stopBtn.style.display = 'none';
    setStatus(null, 'Idle');
  }

  if (session && session.lastSummary) {
    renderSummary(session.lastSummary);
  } else {
    els.summaryCard.style.display = 'none';
  }

  if (session && session.lastError) {
    els.errorCard.style.display = 'block';
    els.errorBody.innerHTML = session.lastError;
    setStatus('error', 'LLM error');
  } else {
    els.errorCard.style.display = 'none';
  }
}

function renderSummary(summary) {
  els.summaryCard.style.display = 'block';
  els.finalScore.textContent = Math.round(summary.score || 0);
  els.finalDuration.textContent = formatDuration(summary.duration || 0);
  els.finalPro.textContent = String(summary.pro || 0);
  els.finalAnti.textContent = String(summary.anti || 0);

  els.topSitesList.innerHTML = '';
  const sites = summary.topSites || [];
  if (sites.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="site-domain">No data recorded</span><span class="site-time">—</span>`;
    els.topSitesList.appendChild(li);
    return;
  }
  for (const s of sites.slice(0, 5)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="site-domain">${s.domain}</span><span class="site-time">${formatDuration(s.seconds)}</span>`;
    els.topSitesList.appendChild(li);
  }
}

// ---------- background comms ----------
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false });
      }
    });
  });
}

async function refresh() {
  const res = await sendMessage({ type: 'GET_SESSION' });
  if (res && res.session) {
    // Pre-fill from saved goal/time
    if (!res.session.active) {
      if (res.session.goal) els.goalInput.value = res.session.goal;
      if (res.session.plannedMinutes) {
        const presets = ['15', '30', '60', '120'];
        const val = String(res.session.plannedMinutes);
        if (presets.includes(val)) {
          els.timeInput.value = val;
          els.customTimeInput.style.display = 'none';
        } else {
          els.timeInput.value = 'custom';
          els.customTimeInput.style.display = 'block';
          els.customTimeInput.value = val;
        }
      }
    }
    renderSession(res.session);
  }
}

// ---------- handlers ----------
els.timeInput.addEventListener('change', () => {
  els.customTimeInput.style.display = els.timeInput.value === 'custom' ? 'block' : 'none';
});

els.startBtn.addEventListener('click', async () => {
  const goal = els.goalInput.value.trim();
  if (!goal) {
    els.goalInput.focus();
    els.goalInput.style.borderColor = 'var(--red)';
    setTimeout(() => (els.goalInput.style.borderColor = ''), 1200);
    return;
  }
  let minutes;
  if (els.timeInput.value === 'custom') {
    minutes = parseInt(els.customTimeInput.value, 10);
    if (!minutes || minutes < 1) minutes = 30;
  } else {
    minutes = parseInt(els.timeInput.value, 10);
  }

  await sendMessage({ type: 'START_SESSION', goal, plannedMinutes: minutes });
  await refresh();
});

els.stopBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'STOP_SESSION' });
  await refresh();
});

els.resetBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'RESET_SESSION' });
  els.goalInput.value = '';
  els.timeInput.value = '30';
  els.customTimeInput.style.display = 'none';
  els.customTimeInput.value = '';
  await refresh();
});

// ---------- live ticking ----------
function startTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(refresh, 1000);
}
function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();
  startTicking();
});

window.addEventListener('unload', stopTicking);

// Listen for live updates pushed from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'SESSION_UPDATED' || msg.type === 'SCORE_UPDATED')) {
    refresh();
  }
});
