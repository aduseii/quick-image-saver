'use strict';

const DEFAULTS = { hoverButton: true, altClick: true, folder: 'Saved Images', perSite: false, autoUpdate: true };
const $ = (id) => document.getElementById(id);

let items = [];
let tabId = null;
let pageUrl = '';

// ---------- settings ----------
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('hoverButton').checked = !!s.hoverButton;
  $('altClick').checked = !!s.altClick;
  $('perSite').checked = !!s.perSite;
  $('autoUpdate').checked = !!s.autoUpdate;
  $('folder').value = s.folder || '';
  updatePerSiteHint();
}

for (const id of ['hoverButton', 'altClick', 'perSite']) {
  $(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.checked });
    if (id === 'perSite') updatePerSiteHint();
  });
}

let folderTimer = 0;
$('folder').addEventListener('input', () => {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => {
    chrome.storage.sync.set({ folder: $('folder').value.trim() });
    updatePerSiteHint();
  }, 250);
});
$('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

function updatePerSiteHint() {
  let host = 'example.com';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, '') || host; } catch (e) { /* ignore */ }
  const folder = $('folder').value.trim().replace(/[\\/]+$/, '');
  $('perSiteHint').textContent = `e.g. ${folder ? folder + ' / ' : ''}${host}`;
}

// ---------- shortcut ----------
async function loadShortcut() {
  const cmds = await chrome.commands.getAll();
  const cmd = cmds.find((c) => c.name === 'save-hovered');
  const el = $('shortcut');
  el.textContent = '';
  if (cmd && cmd.shortcut) {
    cmd.shortcut.split('+').forEach((key, i) => {
      if (i) el.append(' + ');
      const k = document.createElement('kbd');
      k.textContent = key.trim();
      el.append(k);
    });
  } else {
    el.textContent = 'Keyboard shortcut (not set)';
  }
}
$('changeShortcut').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------- save all ----------
function setLabel(text) { $('saveAllLabel').textContent = text; }

async function collect() {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'collect-all' }, { frameId: 0 });
  try {
    return await ask();
  } catch (e) {
    // Content script not there yet (page opened before install) — inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/resolve.js', 'src/content.js'] });
    return await ask();
  }
}

async function loadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https?|file):/i.test(tab.url || '')) {
    setLabel('Images can’t be saved on this page');
    return;
  }
  tabId = tab.id;
  pageUrl = tab.url;
  updatePerSiteHint();
  try {
    const res = await collect();
    items = (res && res.items) || [];
  } catch (e) {
    setLabel('Images can’t be saved on this page');
    return;
  }
  if (!items.length) {
    setLabel('No large images on this page');
    return;
  }
  setLabel(items.length === 1 ? 'Save the 1 image on this page' : `Save all ${items.length} images on this page`);
  $('saveAll').disabled = false;
}

let savingAll = false;
$('saveAll').addEventListener('click', async () => {
  const button = $('saveAll');
  button.disabled = true;
  savingAll = true;
  setLabel(`Saving 0 of ${items.length}…`);
  $('bar').hidden = false;
  const res = await chrome.runtime.sendMessage({ type: 'save-many', items, pageUrl }).catch(() => null);
  savingAll = false; // a late progress message must not overwrite the result
  $('barFill').style.width = '100%';
  if (res && res.ok) {
    $('bar').hidden = true;
    button.classList.add('done');
    setLabel(res.failed
      ? `Saved ${res.saved} · ${res.failed} couldn’t be saved`
      : `Saved ${res.saved} image${res.saved === 1 ? '' : 's'}`);
  } else {
    setLabel('Something went wrong — try again');
    button.disabled = false;
  }
  loadCount();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (savingAll && msg && msg.type === 'progress' && msg.total) {
    setLabel(`Saving ${msg.done} of ${msg.total}…`);
    $('barFill').style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
  }
});

// ---------- counter ----------
async function loadCount() {
  const { savedCount = 0 } = await chrome.storage.local.get({ savedCount: 0 });
  $('count').textContent = savedCount
    ? `${savedCount.toLocaleString()} image${savedCount === 1 ? '' : 's'} saved so far`
    : '';
}

// ---------- updates ----------
function showUpdate(state, justUpdated) {
  const el = $('updateStatus');
  const running = chrome.runtime.getManifest().version;
  let text = `Version ${running}`;
  let tone = '';
  let needsSetup = false;
  state = state || {};
  const available = state.available && state.latest && state.running === running;
  if (available && state.downloaded) {
    text = `Downloaded ${state.latest}. Unzip it over the extension folder, then Reload.`;
    tone = 'warn';
    needsSetup = state.helper === 'missing';
  } else if (available && !$('autoUpdate').checked) {
    text = `Version ${state.latest} is out · switch this on to install it`;
    tone = 'warn';
  } else if (available && state.helper === 'missing') {
    text = `Version ${state.latest} is out · needs one-time setup`;
    tone = 'warn';
    needsSetup = true;
  } else if (available && state.error) {
    text = `Version ${state.latest} is out · couldn’t install yet, will retry`;
    tone = 'warn';
  } else if (available) {
    text = `Version ${state.latest} is out · installing soon`;
    tone = 'warn';
  } else if (justUpdated && justUpdated.to === running && Date.now() - justUpdated.at < 36 * 3600 * 1000) {
    text = `Updated to ${running} ✓`;
    tone = 'good';
  } else if (state.helper === 'missing') {
    text = `Version ${running} · auto-update needs one-time setup`;
    needsSetup = true;
  } else if (state.error) {
    text = `Version ${running} · couldn’t check (${state.error})`;
  } else if (state.latest && state.helper === 'on') {
    text = `Version ${running} · up to date, auto-update on ✓`;
    tone = 'good';
  } else if (state.latest) {
    text = `Version ${running} · up to date`;
  }
  el.textContent = text;
  el.className = `hint ${tone}`;
  $('setupLink').hidden = !needsSetup;
}

async function loadUpdate() {
  const { update, justUpdated } = await chrome.storage.local.get({ update: null, justUpdated: null });
  showUpdate(update, justUpdated);
}

$('checkNow').addEventListener('click', async () => {
  const btn = $('checkNow');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const state = await chrome.runtime.sendMessage({ type: 'check-update' }).catch(() => null);
  btn.disabled = false;
  btn.textContent = 'Check for updates';
  showUpdate(state, null); // if an update installs, the extension restarts and this popup closes
});

$('autoUpdate').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ autoUpdate: e.target.checked });
  if (e.target.checked) $('checkNow').click(); // turning it on installs any waiting update
  else loadUpdate();
});

loadSettings().then(loadUpdate);
loadShortcut();
loadCount();
loadPage();
