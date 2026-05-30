// popup.js — FocusLens popup controller

const $ = (id) => document.getElementById(id);

const PROVIDER_PRESETS = {
  lmstudio:  { label: 'LM Studio',         baseUrl: 'http://127.0.0.1:1234',  model: 'qwen/qwen3-vl-4b' },
  ollama:    { label: 'Ollama',            baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
  llamacpp:  { label: 'llama.cpp / vLLM',  baseUrl: 'http://127.0.0.1:8080',  model: '' },
  custom:    { label: 'Custom',            baseUrl: '',                       model: '' },
};

const els = {
  // server card
  serverCard: $('serverCard'),
  serverHeader: $('serverHeader'),
  serverSummary: $('serverSummary'),
  serverDot: $('serverDot'),
  serverToggle: $('serverToggle'),
  serverBody: $('serverBody'),
  providerSelect: $('providerSelect'),
  baseUrlInput: $('baseUrlInput'),
  testConnBtn: $('testConnBtn'),
  testStatus: $('testStatus'),
  modelSelect: $('modelSelect'),
  modelManualInput: $('modelManualInput'),
  saveServerBtn: $('saveServerBtn'),
  cancelServerBtn: $('cancelServerBtn'),
  // goal + session
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

// ---------- LLM server settings ----------
let currentLLMSettings = null;

function renderServerSummary(settings) {
  currentLLMSettings = settings || null;
  const configured = !!(settings && settings.baseUrl && settings.model);
  if (configured) {
    const providerLabel = (PROVIDER_PRESETS[settings.provider] || {}).label || 'Custom';
    els.serverSummary.textContent = `${settings.model} · ${providerLabel}`;
    els.serverSummary.title = `${settings.model} @ ${settings.baseUrl}`;
    els.serverDot.classList.remove('error', 'warn');
    els.serverDot.classList.add('ok');
    els.startBtn.disabled = false;
    els.startBtn.classList.remove('btn-disabled');
  } else {
    els.serverSummary.textContent = 'Configure LLM server';
    els.serverSummary.title = '';
    els.serverDot.classList.remove('ok', 'error');
    els.serverDot.classList.add('warn');
    els.startBtn.disabled = true;
    els.startBtn.classList.add('btn-disabled');
  }
}

function openServerEditor(settings) {
  els.serverBody.style.display = 'flex';
  const s = settings || currentLLMSettings || { provider: 'lmstudio', baseUrl: '', model: '' };
  els.providerSelect.value = s.provider || 'custom';
  els.baseUrlInput.value = s.baseUrl || '';
  if (s.model) {
    populateModelSelect([s.model], s.model);
    els.modelManualInput.value = '';
  } else {
    populateModelSelect([], '');
  }
  els.testStatus.textContent = '';
  els.testStatus.className = 'test-status';
}

function closeServerEditor() {
  els.serverBody.style.display = 'none';
}

function populateModelSelect(models, selected) {
  els.modelSelect.innerHTML = '';
  if (!models || models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— test connection to load models —';
    els.modelSelect.appendChild(opt);
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.disabled = false;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === selected) opt.selected = true;
    els.modelSelect.appendChild(opt);
  }
}

async function refreshLLMSettings() {
  const res = await sendMessage({ type: 'GET_LLM_SETTINGS' });
  if (res && res.ok) renderServerSummary(res.llmSettings);
}

els.serverToggle.addEventListener('click', () => {
  if (els.serverBody.style.display === 'flex') closeServerEditor();
  else openServerEditor();
});

els.providerSelect.addEventListener('change', () => {
  const preset = PROVIDER_PRESETS[els.providerSelect.value];
  if (preset && preset.baseUrl) els.baseUrlInput.value = preset.baseUrl;
  if (preset && preset.model && !els.modelManualInput.value) {
    els.modelManualInput.value = preset.model;
  }
});

els.testConnBtn.addEventListener('click', async () => {
  const baseUrl = els.baseUrlInput.value.trim();
  if (!baseUrl) {
    els.testStatus.textContent = 'Enter a base URL first';
    els.testStatus.className = 'test-status error';
    return;
  }
  els.testStatus.textContent = 'Testing…';
  els.testStatus.className = 'test-status loading';
  els.testConnBtn.disabled = true;
  try {
    const res = await sendMessage({ type: 'TEST_LLM_CONNECTION', baseUrl });
    if (res.ok) {
      const models = res.models || [];
      if (models.length === 0) {
        els.testStatus.textContent = 'Connected · no models loaded';
        els.testStatus.className = 'test-status warn';
        populateModelSelect([], '');
      } else {
        const preferred = (currentLLMSettings && currentLLMSettings.model && models.includes(currentLLMSettings.model))
          ? currentLLMSettings.model
          : models[0];
        populateModelSelect(models, preferred);
        els.modelManualInput.value = '';
        els.testStatus.textContent = `Connected · ${models.length} model${models.length === 1 ? '' : 's'}`;
        els.testStatus.className = 'test-status ok';
      }
    } else {
      els.testStatus.textContent = `Failed: ${res.error || 'unknown error'}`;
      els.testStatus.className = 'test-status error';
    }
  } finally {
    els.testConnBtn.disabled = false;
  }
});

els.saveServerBtn.addEventListener('click', async () => {
  const baseUrl = els.baseUrlInput.value.trim();
  const model = (els.modelManualInput.value.trim() || els.modelSelect.value || '').trim();
  if (!baseUrl) {
    els.testStatus.textContent = 'Base URL is required';
    els.testStatus.className = 'test-status error';
    return;
  }
  if (!model) {
    els.testStatus.textContent = 'Select or type a model id';
    els.testStatus.className = 'test-status error';
    return;
  }
  const res = await sendMessage({
    type: 'SAVE_LLM_SETTINGS',
    provider: els.providerSelect.value,
    baseUrl,
    model,
  });
  if (res.ok) {
    renderServerSummary(res.llmSettings);
    closeServerEditor();
  }
});

els.cancelServerBtn.addEventListener('click', closeServerEditor);

async function refresh() {
  const res = await sendMessage({ type: 'GET_SESSION' });
  if (res && res.session) {
    if (res.llmSettings) renderServerSummary(res.llmSettings);
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

  const res = await sendMessage({ type: 'START_SESSION', goal, plannedMinutes: minutes });
  if (!res.ok) {
    // most likely server not configured — open the editor
    openServerEditor();
    els.testStatus.textContent = res.error || 'Could not start session';
    els.testStatus.className = 'test-status error';
    return;
  }
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
  // First-run guidance: auto-expand editor if server not fully configured
  if (!currentLLMSettings || !currentLLMSettings.baseUrl || !currentLLMSettings.model) {
    openServerEditor(currentLLMSettings);
  }
  startTicking();
});

window.addEventListener('unload', stopTicking);

// Listen for live updates pushed from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'SESSION_UPDATED' || msg.type === 'SCORE_UPDATED')) {
    refresh();
  }
});
