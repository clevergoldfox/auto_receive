/* Crowdworks Auto Bid — background service worker
 *
 * Responsibilities:
 *  - Authenticate to Google Sheets with the bundled service account (JWT -> access token).
 *  - Poll the configured sheet on an interval; detect newly-added rows.
 *  - For each new row, build a prompt and ask the selected AI provider for a bid.
 *  - Open the Crowdworks job page and let content.js fill / submit the proposal.
 */

// Watchdog alarm: wakes the worker ~every minute to re-create the offscreen
// timer if it (or the worker) was torn down. The 5s polling itself is driven
// by the offscreen document, not by this alarm.
const ALARM = 'cw-watchdog';

const OFFSCREEN_URL = 'offscreen.html';

function intervalMs(settings) {
  return Math.max(5000, (settings.pollIntervalSec || 5) * 1000);
}

const DEFAULT_PROMPT =
`Title: {title}

Budget: {budget}

Detail: {detail}

This is a specification that automatically bids on the task by determining a reasonable price that the client can accept based on the written bid.`;

// Instruction added on top of the user's prompt so we can parse a structured result.
const SYSTEM_PROMPT =
`You are an assistant that writes winning bid proposals for tasks on Crowdworks (crowdworks.jp).
Decide a reasonable bid price in Japanese yen that the client is likely to accept, based on the stated budget.
Reply with ONLY a JSON object and nothing else, in this exact shape:
{"price": <integer, Japanese yen, digits only>, "message": "<proposal message addressed to the client, written in natural Japanese>"}`;

/* ----------------------------------------------------------------------- *
 * Storage helpers
 * ----------------------------------------------------------------------- */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || {};
}
async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || {};
}
async function patchState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}
async function log(msg, level = 'info') {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.push({ t: Date.now(), level, msg });
  while (logs.length > 200) logs.shift();
  await chrome.storage.local.set({ logs });
  console.log(`[CW ${level}] ${msg}`);
}

/* ----------------------------------------------------------------------- *
 * Service-account auth (RS256 JWT -> OAuth access token)
 * ----------------------------------------------------------------------- */

let cachedToken = null; // { token, expMs }

function base64Url(input) {
  let bin;
  if (typeof input === 'string') {
    bin = btoa(unescape(encodeURIComponent(input)));
  } else {
    bin = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return bin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getSheetToken() {
  if (cachedToken && cachedToken.expMs > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const sa = await (await fetch(chrome.runtime.getURL('service_account.json'))).json();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64Url(sig)}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token error: ${data.error_description || data.error || res.status}`);
  }
  cachedToken = { token: data.access_token, expMs: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

/* ----------------------------------------------------------------------- *
 * Google Sheets reading
 * ----------------------------------------------------------------------- */

function extractSheetId(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

function cellHyperlink(cell) {
  if (!cell) return '';
  if (cell.hyperlink) return cell.hyperlink;          // =HYPERLINK() or cell-level link
  for (const run of cell.textFormatRuns || []) {       // rich-text link inside the cell
    if (run.format && run.format.link && run.format.link.uri) return run.format.link.uri;
  }
  return '';
}

// Returns an array of { title, budget, detail, url } indexed by sheet row (0-based).
async function fetchRows() {
  const settings = await getSettings();
  const sheetId = extractSheetId(settings.sheetUrl);
  if (!sheetId) throw new Error('Sheet URL is missing or invalid.');

  const token = await getSheetToken();
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // Resolve (and cache) the first sheet's tab title so we can build an A1 range.
  let title = (await getState()).sheetTitle;
  if (!title) {
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
      auth,
    );
    const meta = await metaRes.json();
    if (!metaRes.ok) {
      throw new Error(`Sheets metadata error: ${meta.error?.message || metaRes.status}`);
    }
    title = meta.sheets[0].properties.title;
    await patchState({ sheetTitle: title });
  }

  const range = encodeURIComponent(`${title}!C1:E100000`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}` +
    `?ranges=${range}&includeGridData=true` +
    `&fields=sheets.data.rowData.values(formattedValue,hyperlink,textFormatRuns)`;
  const res = await fetch(url, auth);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Sheets read error: ${data.error?.message || res.status}`);
  }
  const rowData = data.sheets?.[0]?.data?.[0]?.rowData || [];
  return rowData.map((row) => {
    const v = row.values || [];
    return {
      title: v[0]?.formattedValue || '',   // column C
      budget: v[1]?.formattedValue || '',  // column D
      detail: v[2]?.formattedValue || '',  // column E
      url: cellHyperlink(v[0]),            // hyperlink on the column C title cell
    };
  });
}

/* ----------------------------------------------------------------------- *
 * AI providers
 * ----------------------------------------------------------------------- */

async function callOpenAI(key, model, system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
  return data.choices[0].message.content;
}

async function callGemini(key, model, system, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
  return data.candidates[0].content.parts[0].text;
}

async function callClaude(key, model, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude HTTP ${res.status}`);
  return data.content[0].text;
}

function parseBid(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) text = obj[0];
  try {
    const j = JSON.parse(text);
    return {
      price: parseInt(String(j.price).replace(/[^\d]/g, ''), 10),
      message: String(j.message || '').trim(),
    };
  } catch {
    return { price: NaN, message: '' };
  }
}

async function generateBid(task, settings) {
  const provider = settings.provider || 'openai';
  const key = (settings.apiKeys || {})[provider] || '';
  const model = (settings.models || {})[provider] || '';
  if (!key) throw new Error(`No API key saved for "${provider}".`);

  const userPrompt = (settings.prompt || DEFAULT_PROMPT)
    .split('{title}').join(task.title)
    .split('{budget}').join(task.budget)
    .split('{detail}').join(task.detail);

  let raw;
  if (provider === 'openai' || provider === 'cursor') {
    // Cursor has no official public completion API; it is wired here as an
    // OpenAI-compatible call. See README / popup note.
    raw = await callOpenAI(key, model, SYSTEM_PROMPT, userPrompt);
  } else if (provider === 'gemini') {
    raw = await callGemini(key, model, SYSTEM_PROMPT, userPrompt);
  } else if (provider === 'claude') {
    raw = await callClaude(key, model, SYSTEM_PROMPT, userPrompt);
  } else {
    throw new Error(`Unknown provider "${provider}".`);
  }

  const bid = parseBid(raw);
  if (!bid.price || !bid.message) {
    throw new Error('AI did not return a usable price/message JSON.');
  }
  return bid;
}

/* ----------------------------------------------------------------------- *
 * Task queue & bidding flow
 * ----------------------------------------------------------------------- */

let polling = false; // guards against overlapping ticks within one worker life

async function poll() {
  const settings = await getSettings();
  if (!settings.running) return;
  if (polling) return;
  polling = true;
  try {
    await checkStale();
    const rows = await fetchRows();
    const state = await getState();
    const baseline = state.baseline ?? rows.length;
    const processed = state.processed || {};
    const queue = state.queue || [];

    for (let i = baseline; i < rows.length; i++) {
      if (processed[i]) continue;
      processed[i] = true;
      const row = rows[i];
      if (!row.title && !row.detail) continue;            // blank row
      if (!row.url) {
        await log(`Row ${i + 1}: no hyperlink on the title cell — skipped.`, 'warn');
        continue;
      }
      queue.push({ ...row, rowIndex: i + 1 });
      await log(`New task queued (row ${i + 1}): ${row.title}`);
    }
    await patchState({ baseline, processed, queue });
    await drainQueue();
  } catch (e) {
    await log(`Poll error: ${e.message}`, 'error');
  } finally {
    polling = false;
  }
}

async function checkStale() {
  const state = await getState();
  const ab = state.activeBid;
  if (ab && Date.now() - ab.startedAt > 150_000) {
    await log(`Bid timed out for "${ab.title}".`, 'error');
    chrome.tabs.remove(ab.tabId).catch(() => {});
    await patchState({ activeBid: null });
  }
}

async function drainQueue() {
  const state = await getState();
  if (state.activeBid) return;            // one bid at a time
  const queue = state.queue || [];
  if (!queue.length) return;
  const task = queue.shift();
  await patchState({ queue });
  await processTask(task);
}

async function processTask(task) {
  const settings = await getSettings();
  let bid;
  try {
    await log(`Generating bid for "${task.title}"…`);
    bid = await generateBid(task, settings);
  } catch (e) {
    await log(`AI error for "${task.title}": ${e.message}`, 'error');
    await drainQueue();                   // skip this task, continue with the next
    return;
  }
  const jobId = (task.url.match(/jobs\/(\d+)/) || [])[1] || '';
  const tab = await chrome.tabs.create({ url: task.url, active: false });
  await patchState({
    activeBid: {
      jobId,
      url: task.url,
      title: task.title,
      price: bid.price,
      message: bid.message,
      tabId: tab.id,
      startedAt: Date.now(),
    },
  });
  await log(`Opened job page for "${task.title}" — proposed price ¥${bid.price}.`);
}

/* ----------------------------------------------------------------------- *
 * Start / stop
 * ----------------------------------------------------------------------- */

// --- offscreen timer management ---------------------------------------- //

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // MV3 has no "timer" reason; this offscreen page only runs a setInterval
    // to enable sub-30s polling that chrome.alarms cannot provide.
    reasons: ['BLOBS'],
    justification: 'Runs a sub-30s polling timer not available via chrome.alarms.',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function startTimer() {
  await ensureOffscreen();
  const settings = await getSettings();
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-timer',
    intervalMs: intervalMs(settings),
  }).catch(() => {});
}

async function stopTimer() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-timer' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function startMonitoring() {
  try {
    const rows = await fetchRows();
    await patchState({ baseline: rows.length, processed: {}, queue: [], activeBid: null });
    await patchSettings({ running: true });
    await startTimer();
    chrome.alarms.create(ALARM, { periodInMinutes: 1 }); // watchdog only
    const sec = (await getSettings()).pollIntervalSec || 5;
    await log(`Monitoring started (every ${sec}s). Baseline = ${rows.length} rows; only rows added after now will be bid on.`);
  } catch (e) {
    await patchSettings({ running: false });
    await log(`Could not start: ${e.message}`, 'error');
  }
}

async function stopMonitoring() {
  await patchSettings({ running: false });
  chrome.alarms.clear(ALARM);
  await stopTimer();
  await log('Monitoring stopped.');
}

/* ----------------------------------------------------------------------- *
 * Event wiring
 * ----------------------------------------------------------------------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const settings = await getSettings();
  if (!settings.running) return;
  // Re-create the offscreen timer if it (or the worker) was torn down,
  // and run one poll as a fallback in case ticks were missed.
  await startTimer();
  poll();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.activeBid && state.activeBid.tabId === tabId) {
    await patchState({ activeBid: null });
    await drainQueue();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'cw-tick') {
      poll();
      sendResponse({ ok: true });
    } else if (msg.type === 'popup-start') {
      await startMonitoring();
      sendResponse({ ok: true });
    } else if (msg.type === 'popup-stop') {
      await stopMonitoring();
      sendResponse({ ok: true });
    } else if (msg.type === 'cw-get-task') {
      // content.js asks what (if anything) it should do on its tab.
      const state = await getState();
      const ab = state.activeBid;
      if (ab && sender.tab && sender.tab.id === ab.tabId) {
        const settings = await getSettings();
        sendResponse({
          task: {
            jobId: ab.jobId,
            price: ab.price,
            message: ab.message,
            autoSubmit: settings.autoSubmit !== false,
          },
        });
      } else {
        sendResponse({ task: null });
      }
    } else if (msg.type === 'cw-bid-done') {
      const state = await getState();
      const ab = state.activeBid;
      if (ab) {
        if (msg.ok) {
          await log(`Bid ${msg.filledOnly ? 'filled (awaiting your review)' : 'submitted'} for "${ab.title}".`);
          if (!msg.filledOnly) setTimeout(() => chrome.tabs.remove(ab.tabId).catch(() => {}), 4000);
        } else {
          await log(`Bid failed for "${ab.title}": ${msg.error || 'unknown error'}`, 'error');
        }
        await patchState({ activeBid: null });
        await drainQueue();
      }
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Re-arm the alarm if the worker restarts while monitoring is on.
chrome.runtime.onStartup.addListener(rearm);
chrome.runtime.onInstalled.addListener(rearm);
async function rearm() {
  const settings = await getSettings();
  if (settings.running) {
    chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    await startTimer();
  }
}
