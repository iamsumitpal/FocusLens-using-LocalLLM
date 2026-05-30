// background.js — FocusLens service worker

const DEFAULT_LLM_SETTINGS = {
  provider: 'lmstudio',
  baseUrl: 'http://127.0.0.1:1234',
  model: 'qwen/qwen3-vl-4b',
};

const DEBOUNCE_MS = 10_000;       // minimum 10s between API calls
const SAME_PAGE_THRESHOLD_MS = 30_000; // re-evaluate same page every 30s
const SCORE_SCALING = 15;          // weight × 15 → score delta
const SCORE_MIN = -100;
const SCORE_MAX = 100;

// ---------------- state helpers ----------------
const defaultSession = () => ({
  active: false,
  goal: '',
  plannedMinutes: 30,
  startedAt: null,
  score: 0,
  activityLog: [],          // {url, domain, title, classification, weight, reason, ts, secondsOnPage}
  domainTime: {},           // {domain: seconds}
  lastEvalTs: 0,            // last LLM call timestamp
  lastError: null,
  lastSummary: null,
  currentPage: null,        // {tabId, url, title, enteredAt, lastEvaluatedAt}
});

async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return defaultSession();
  return session;
}

async function setSession(session) {
  await chrome.storage.local.set({ session });
}

async function updateSession(updater) {
  const s = await getSession();
  const next = updater(s) || s;
  await setSession(next);
  return next;
}

function safeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

function isTrackable(url) {
  if (!url) return false;
  if (url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('about:')) return false;
  if (url.startsWith('edge://')) return false;
  if (url.startsWith('devtools://')) return false;
  if (url.startsWith('view-source:')) return false;
  return /^https?:/.test(url);
}

// ---------------- broadcasting ----------------
function broadcastToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab may not have content script (e.g. chrome:// pages). Ignore.
  });
}

function broadcastScore(session, extra = {}) {
  // Update overlay on current tab
  if (session.currentPage && session.currentPage.tabId) {
    broadcastToTab(session.currentPage.tabId, {
      type: 'FOCUS_UPDATE',
      score: session.score,
      ...extra,
    });
  }
  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'SCORE_UPDATED' }).catch(() => {});
}

function notifySessionUpdated() {
  chrome.runtime.sendMessage({ type: 'SESSION_UPDATED' }).catch(() => {});
}

// ---------------- session control ----------------
async function startSession(goal, plannedMinutes) {
  const session = defaultSession();
  session.active = true;
  session.goal = goal;
  session.plannedMinutes = plannedMinutes;
  session.startedAt = Date.now();
  await setSession(session);
  // Begin tracking current active tab immediately
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && isTrackable(activeTab.url)) {
    await beginPageVisit(activeTab.id, activeTab.url, activeTab.title || '');
    // Trigger an immediate evaluation
    requestContentFromTab(activeTab.id);
  }
  notifySessionUpdated();
}

async function stopSession() {
  const s = await getSession();
  if (!s.active) {
    notifySessionUpdated();
    return;
  }
  // Flush time on current page
  await flushCurrentPageTime(s);
  const finalSession = await getSession();
  const log = finalSession.activityLog || [];
  const pro = log.filter((a) => a.classification === 'pro-goal').length;
  const anti = log.filter((a) => a.classification === 'anti-goal').length;
  const duration = finalSession.startedAt ? Math.floor((Date.now() - finalSession.startedAt) / 1000) : 0;

  const topSites = Object.entries(finalSession.domainTime || {})
    .map(([domain, seconds]) => ({ domain, seconds }))
    .sort((a, b) => b.seconds - a.seconds);

  const summary = {
    score: finalSession.score,
    duration,
    pro,
    anti,
    topSites,
    goal: finalSession.goal,
  };
  await updateSession((cur) => {
    cur.active = false;
    cur.currentPage = null;
    cur.lastSummary = summary;
    return cur;
  });
  notifySessionUpdated();
}

async function resetSession() {
  const fresh = defaultSession();
  await setSession(fresh);
  notifySessionUpdated();
}

// ---------------- page tracking ----------------
async function flushCurrentPageTime(sessionIn) {
  const s = sessionIn || (await getSession());
  if (!s.currentPage) return s;
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - s.currentPage.enteredAt) / 1000));
  if (seconds > 0) {
    const domain = safeDomain(s.currentPage.url);
    s.domainTime[domain] = (s.domainTime[domain] || 0) + seconds;
  }
  s.currentPage = null;
  await setSession(s);
  return s;
}

async function beginPageVisit(tabId, url, title) {
  const s = await getSession();
  if (!s.active) return;
  if (!isTrackable(url)) return;

  // If different page, flush previous
  if (s.currentPage && s.currentPage.tabId === tabId && s.currentPage.url === url) {
    return; // same page, no change
  }
  await flushCurrentPageTime(s);
  const s2 = await getSession();
  s2.currentPage = {
    tabId,
    url,
    title: title || '',
    enteredAt: Date.now(),
    lastEvaluatedAt: 0,
  };
  await setSession(s2);
}

function requestContentFromTab(tabId) {
  if (!tabId) return;
  // Ask content script for page payload
  chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_PAGE' }).catch(() => {
    // Content script may not be present (e.g., still loading). Will retry on next event.
  });
}

// ---------------- LLM call ----------------
function buildMessages({ goal, plannedMinutes, elapsedSeconds, url, title, text, secondsOnPage, contentType, screenshotDataUrl }) {
  const systemPrompt = `You are a focus assistant. The user has set a focus goal and a time limit. You will receive the user's current browsing activity including page content, page URL, and time spent. Your job is to classify whether this activity is helping the user achieve their goal (pro-goal) or distracting them (anti-goal), and assign a weight.

Respond ONLY in this JSON format:
{
  "classification": "pro-goal" | "anti-goal",
  "weight": <float between -1.0 and 1.0>,
  "reason": "<one sentence explanation>"
}

Weight guidelines:
- Magnitude (0.0 to 1.0) depends on: how relevant the content is to the goal AND time spent
- Sign: positive for pro-goal, negative for anti-goal
- Brief google searches with low time spent = low magnitude (0.05-0.15)
- Deep reading/watching highly relevant content for long time = high magnitude (0.6-1.0)
- Slightly related but not directly helpful = medium magnitude (0.2-0.4)
- Completely unrelated content = negative, magnitude based on time spent`;

  const userText = `Goal: ${goal}
Time planned: ${plannedMinutes} minutes
Time elapsed in session: ${Math.floor(elapsedSeconds)}s

Current Activity:
- URL: ${url}
- Page Title: ${title}
- Page Content (excerpt): ${text || '(no text content available)'}
- Time spent on this page: ${secondsOnPage} seconds
- Content type: ${contentType || 'text'}

Classify this activity and assign a weight.`;

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  if (screenshotDataUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: screenshotDataUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userText });
  }
  return messages;
}

function tryParseLLMJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Strip ``` fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  // Extract first JSON object
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!parsed.classification || typeof parsed.weight !== 'number') return null;
    parsed.weight = Math.max(-1, Math.min(1, parsed.weight));
    parsed.classification = parsed.classification === 'pro-goal' ? 'pro-goal' : 'anti-goal';
    if (!parsed.reason) parsed.reason = '';
    return parsed;
  } catch {
    return null;
  }
}

async function getLLMSettings() {
  const { llmSettings } = await chrome.storage.local.get('llmSettings');
  return { ...DEFAULT_LLM_SETTINGS, ...(llmSettings || {}) };
}

async function setLLMSettings(partial) {
  const merged = { ...(await getLLMSettings()), ...partial };
  await chrome.storage.local.set({ llmSettings: merged });
  return merged;
}

function normaliseBaseUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  u = u.replace(/\/+$/, '');           // strip trailing slashes
  u = u.replace(/\/v1$/, '');          // strip trailing /v1 if user pasted full path
  return u;
}

async function listModels(baseUrl) {
  const url = `${normaliseBaseUrl(baseUrl)}/v1/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const ids = (data?.data || []).map((m) => m.id).filter(Boolean);
    return ids;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLM(messages) {
  const settings = await getLLMSettings();
  const endpoint = `${normaliseBaseUrl(settings.baseUrl)}/v1/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.3,
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`LLM server HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = tryParseLLMJson(content);
    if (!parsed) throw new Error('Could not parse JSON from LLM response.');
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------- evaluation pipeline ----------------
async function evaluateActivity(payload) {
  // payload: from content script -> {url, title, text, contentType, videoMeta?}
  const s = await getSession();
  if (!s.active) return;
  if (!s.currentPage) return;

  const now = Date.now();
  if (now - s.lastEvalTs < DEBOUNCE_MS) return; // global debounce

  const elapsedSeconds = s.startedAt ? (now - s.startedAt) / 1000 : 0;
  const secondsOnPage = Math.floor((now - s.currentPage.enteredAt) / 1000);

  // Decide whether to include a screenshot
  let screenshotDataUrl = null;
  const isVideo = payload.contentType === 'video';
  const lowText = !payload.text || payload.text.length < 200;
  if (isVideo || lowText) {
    try {
      // captureVisibleTab captures the active tab in the current window
      screenshotDataUrl = await new Promise((resolve) => {
        chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else resolve(dataUrl);
        });
      });
    } catch {
      screenshotDataUrl = null;
    }
  }

  let extractText = payload.text || '';
  if (payload.videoMeta) {
    extractText = `[VIDEO]\nTitle: ${payload.videoMeta.title || ''}\nChannel: ${payload.videoMeta.channel || ''}\nDescription: ${(payload.videoMeta.description || '').slice(0, 500)}\n\n${extractText}`;
  }
  extractText = extractText.slice(0, 2000);

  const messages = buildMessages({
    goal: s.goal,
    plannedMinutes: s.plannedMinutes,
    elapsedSeconds,
    url: payload.url,
    title: payload.title,
    text: extractText,
    secondsOnPage,
    contentType: payload.contentType,
    screenshotDataUrl,
  });

  // Mark eval timestamp BEFORE await to prevent re-entry
  await updateSession((cur) => {
    cur.lastEvalTs = now;
    if (cur.currentPage) cur.currentPage.lastEvaluatedAt = now;
    return cur;
  });

  let result;
  try {
    result = await callLLM(messages);
  } catch (err) {
    const settings = await getLLMSettings();
    await updateSession((cur) => {
      cur.lastError = `LLM error: ${escapeHtml(err.message || String(err))}<br/>Make sure your local LLM server is running at <code>${escapeHtml(settings.baseUrl)}</code>, the model <code>${escapeHtml(settings.model)}</code> is loaded, and CORS is enabled.`;
      return cur;
    });
    notifySessionUpdated();
    return;
  }

  // Apply score
  const delta = result.weight * SCORE_SCALING;
  let finalScore;
  let endState = null;
  await updateSession((cur) => {
    cur.lastError = null;
    const newScore = Math.max(SCORE_MIN, Math.min(SCORE_MAX, (cur.score || 0) + delta));
    cur.score = newScore;
    cur.activityLog = cur.activityLog || [];
    cur.activityLog.push({
      ts: now,
      url: payload.url,
      domain: safeDomain(payload.url),
      title: payload.title,
      classification: result.classification,
      weight: result.weight,
      reason: result.reason,
      secondsOnPage,
    });
    finalScore = newScore;
    if (newScore >= SCORE_MAX) endState = 'congrats';
    else if (newScore <= SCORE_MIN) endState = 'alert';
    return cur;
  });

  const session = await getSession();
  broadcastScore(session, { reason: result.reason, classification: result.classification, weight: result.weight });

  if (endState) {
    // Send end-state event to tab and auto-stop the session (require new goal)
    if (session.currentPage && session.currentPage.tabId) {
      broadcastToTab(session.currentPage.tabId, {
        type: 'FOCUS_END',
        endState,
        score: finalScore,
      });
    }
    await stopSession();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------- chrome listeners ----------------
chrome.tabs.onActivated.addListener(async (info) => {
  const s = await getSession();
  if (!s.active) return;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (!tab || !isTrackable(tab.url)) return;
    await beginPageVisit(tab.id, tab.url, tab.title || '');
    // Push current score to new tab overlay
    broadcastToTab(tab.id, { type: 'FOCUS_UPDATE', score: (await getSession()).score, silent: true });
    requestContentFromTab(tab.id);
  } catch { /* tab might not exist */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const s = await getSession();
  if (!s.active) return;
  if (changeInfo.status !== 'complete') return;
  if (!tab.active) return;
  if (!isTrackable(tab.url)) return;
  await beginPageVisit(tabId, tab.url, tab.title || '');
  broadcastToTab(tabId, { type: 'FOCUS_UPDATE', score: (await getSession()).score, silent: true });
  requestContentFromTab(tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (!s.active) return;
  if (s.currentPage && s.currentPage.tabId === tabId) {
    await flushCurrentPageTime(s);
  }
});

// Periodic re-evaluation of same page
chrome.alarms.create('focuslens-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'focuslens-tick') return;
  const s = await getSession();
  if (!s.active || !s.currentPage) return;
  const now = Date.now();
  const sinceEval = now - (s.currentPage.lastEvaluatedAt || 0);
  if (sinceEval >= SAME_PAGE_THRESHOLD_MS) {
    requestContentFromTab(s.currentPage.tabId);
  }
});

// Messages from popup + content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return sendResponse({ ok: false });

      switch (msg.type) {
        case 'GET_SESSION': {
          const session = await getSession();
          const llmSettings = await getLLMSettings();
          return sendResponse({ ok: true, session, llmSettings });
        }
        case 'GET_LLM_SETTINGS': {
          const llmSettings = await getLLMSettings();
          return sendResponse({ ok: true, llmSettings });
        }
        case 'SAVE_LLM_SETTINGS': {
          const saved = await setLLMSettings({
            provider: msg.provider || 'custom',
            baseUrl: normaliseBaseUrl(msg.baseUrl || ''),
            model: (msg.model || '').trim(),
          });
          return sendResponse({ ok: true, llmSettings: saved });
        }
        case 'TEST_LLM_CONNECTION': {
          const baseUrl = normaliseBaseUrl(msg.baseUrl || '');
          if (!baseUrl) return sendResponse({ ok: false, error: 'Base URL required' });
          try {
            const models = await listModels(baseUrl);
            return sendResponse({ ok: true, models });
          } catch (err) {
            return sendResponse({ ok: false, error: err.message || String(err) });
          }
        }
        case 'START_SESSION': {
          const settings = await getLLMSettings();
          if (!settings.baseUrl || !settings.model) {
            return sendResponse({ ok: false, error: 'Configure your LLM server first.' });
          }
          await startSession(msg.goal || '', parseInt(msg.plannedMinutes, 10) || 30);
          return sendResponse({ ok: true });
        }
        case 'STOP_SESSION': {
          await stopSession();
          return sendResponse({ ok: true });
        }
        case 'RESET_SESSION': {
          await resetSession();
          return sendResponse({ ok: true });
        }
        case 'PAGE_DATA': {
          // From content script
          const payload = msg.payload || {};
          if (sender.tab && sender.tab.id) {
            const s = await getSession();
            if (s.active && s.currentPage && s.currentPage.tabId === sender.tab.id) {
              evaluateActivity(payload);
            }
          }
          return sendResponse({ ok: true });
        }
        case 'CONTENT_READY': {
          // Content script signals it's mounted. If session is active and this is current tab, request capture.
          const s = await getSession();
          if (s.active && sender.tab && s.currentPage && s.currentPage.tabId === sender.tab.id) {
            requestContentFromTab(sender.tab.id);
          }
          // Send current score so overlay can initialize
          sendResponse({ ok: true, session: s });
          return;
        }
        default:
          return sendResponse({ ok: false, error: 'unknown_message' });
      }
    } catch (err) {
      console.error('[FocusLens bg] error', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});

// Initialize storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['session', 'llmSettings']);
  if (!existing.session) await setSession(defaultSession());
  if (!existing.llmSettings) await chrome.storage.local.set({ llmSettings: { ...DEFAULT_LLM_SETTINGS } });
});
