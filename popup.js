/* Crowdworks Auto Bid — popup UI logic */

const DEFAULT_PROMPT =
`Title: {title}

Budget: {budget}

Detail: {detail}

This is a specification that automatically bids on the task by determining a reasonable price that the client can accept based on the written bid.`;

const MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022'],
  cursor: ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6'],
};

const DEFAULTS = {
  provider: 'openai',
  apiKeys: { openai: '', gemini: '', claude: '', cursor: '' },
  models: { openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', claude: 'claude-sonnet-4-6', cursor: 'gpt-4o-mini' },
  prompt: DEFAULT_PROMPT,
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1-PL8BvUVVczQ86XJY_e3wm8BMHs3fU4AzBeoI6Yryvk/edit',
  pollIntervalSec: 60,
  autoSubmit: true,
  running: false,
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

/* --------------------------- load / persist --------------------------- */

async function loadSettings() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = {
    ...DEFAULTS,
    ...(stored || {}),
    apiKeys: { ...DEFAULTS.apiKeys, ...((stored || {}).apiKeys || {}) },
    models: { ...DEFAULTS.models, ...((stored || {}).models || {}) },
  };
}
async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

/* ------------------------------ rendering ------------------------------ */

function renderModelOptions() {
  const provider = settings.provider;
  const select = $('model');
  select.innerHTML = '';
  for (const m of MODELS[provider]) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  select.value = settings.models[provider] || MODELS[provider][0];
}

function renderApiField() {
  const provider = settings.provider;
  $('apiProviderLabel').textContent = `(${provider})`;
  const key = settings.apiKeys[provider] || '';
  $('apiKey').value = key;
  // A saved key starts read-only; an empty one starts editable.
  setApiEditable(!key);
  $('cursorNote').classList.toggle('hidden', provider !== 'cursor');
}
function setApiEditable(editable) {
  $('apiKey').readOnly = !editable;
}

function renderPrompt() {
  $('prompt').value = settings.prompt || DEFAULT_PROMPT;
  $('prompt').readOnly = true;
}

function renderStatus() {
  const running = !!settings.running;
  $('statusPill').textContent = running ? 'Running' : 'Stopped';
  $('statusPill').className = `pill ${running ? 'running' : 'stopped'}`;
  $('toggle').textContent = running ? 'Stop' : 'Start';
  $('toggle').classList.toggle('is-running', running);
}

async function renderLog() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const box = $('log');
  box.innerHTML = '';
  for (const entry of logs.slice(-80)) {
    const time = new Date(entry.t).toLocaleTimeString();
    const line = document.createElement('div');
    line.innerHTML =
      `<span class="l-time">${time}</span>` +
      `<span class="l-${entry.level}">${escapeHtml(entry.msg)}</span>`;
    box.appendChild(line);
  }
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderAll() {
  $('provider').value = settings.provider;
  $('sheetUrl').value = settings.sheetUrl;
  $('interval').value = String(settings.pollIntervalSec);
  $('autoSubmit').checked = settings.autoSubmit !== false;
  renderApiField();
  renderModelOptions();
  renderPrompt();
  renderStatus();
  renderLog();
}

/* ------------------------------- events -------------------------------- */

function wireEvents() {
  $('provider').addEventListener('change', async () => {
    settings.provider = $('provider').value;
    await saveSettings();
    renderApiField();
    renderModelOptions();
  });

  $('model').addEventListener('change', async () => {
    settings.models[settings.provider] = $('model').value;
    await saveSettings();
  });

  // --- API key: Save / Edit / Clear ---
  $('apiSave').addEventListener('click', async () => {
    settings.apiKeys[settings.provider] = $('apiKey').value.trim();
    await saveSettings();
    setApiEditable(false);
  });
  $('apiEdit').addEventListener('click', () => {
    setApiEditable(true);
    $('apiKey').focus();
  });
  $('apiClear').addEventListener('click', async () => {
    settings.apiKeys[settings.provider] = '';
    $('apiKey').value = '';
    await saveSettings();
    setApiEditable(true);
  });

  // --- Prompt: Save / Edit / Clear ---
  $('promptSave').addEventListener('click', async () => {
    settings.prompt = $('prompt').value;
    await saveSettings();
    $('prompt').readOnly = true;
  });
  $('promptEdit').addEventListener('click', () => {
    $('prompt').readOnly = false;
    $('prompt').focus();
  });
  $('promptClear').addEventListener('click', async () => {
    settings.prompt = '';
    $('prompt').value = '';
    $('prompt').readOnly = false;
    await saveSettings();
  });

  // --- Monitoring settings ---
  $('settingsSave').addEventListener('click', async () => {
    settings.sheetUrl = $('sheetUrl').value.trim();
    settings.pollIntervalSec = parseInt($('interval').value, 10);
    settings.autoSubmit = $('autoSubmit').checked;
    await saveSettings();
    flash($('settingsSave'), 'Saved');
  });

  // --- Start / Stop ---
  $('toggle').addEventListener('click', async () => {
    if (settings.running) {
      await chrome.runtime.sendMessage({ type: 'popup-stop' });
    } else {
      await chrome.runtime.sendMessage({ type: 'popup-start' });
    }
  });

  // Live updates from the background worker.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) {
      const s = changes.settings.newValue || {};
      settings.running = !!s.running;
      renderStatus();
    }
    if (changes.logs) renderLog();
  });
}

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

/* -------------------------------- init --------------------------------- */

(async function init() {
  await loadSettings();
  renderAll();
  wireEvents();
})();
