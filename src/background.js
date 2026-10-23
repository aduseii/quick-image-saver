/*
 * Quick Image Saver — background service worker.
 * Picks the best candidate URL (checking guesses with the server first) and
 * hands it to the browser's download manager — no "Save as" dialog.
 */
'use strict';

importScripts('resolve.js');
const QIS = globalThis.QIS;

const DEFAULTS = { hoverButton: true, altClick: true, folder: 'Saved Images', perSite: false, autoUpdate: true };

// Prefer original JPG/PNG/GIF over CDN-converted formats when the server offers a choice.
const ACCEPT = 'image/png,image/jpeg,image/gif,image/*;q=0.9,*/*;q=0.8';

const MEDIA_EXT_RE = /\.(jpe?g|jfif|pjpeg|png|apng|gif|webp|avif|bmp|svg|tiff?|heic|heif|ico|mp4|m4v|webm|mov|ogv)$/i;
const TYPE_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/apng': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/tiff': 'tif', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv'
};
const SAME_EXT = { jpg: ['jpg', 'jpeg', 'jfif', 'pjpeg'], tif: ['tif', 'tiff'], png: ['png', 'apng'], mp4: ['mp4', 'm4v'] };

// ---------- checking candidates ----------
async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  const base = { credentials: 'include', redirect: 'follow', signal: ctl.signal, cache: 'no-cache' };
  try {
    let res = await fetch(url, { ...base, method: 'HEAD', headers: { Accept: ACCEPT } });
    if (!res.ok && [400, 403, 405, 501].includes(res.status)) {
      // Some servers refuse HEAD; ask for a single byte instead.
      res = await fetch(url, { ...base, method: 'GET', headers: { Accept: ACCEPT, Range: 'bytes=0-0' } });
      try { res.body && res.body.cancel(); } catch (e) { /* ignore */ }
    }
    return {
      ok: res.ok,
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      finalUrl: res.url || url
    };
  } catch (e) {
    return { ok: false, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

function isMediaResponse(p, url) {
  if (!p.ok) return false;
  if (p.type.startsWith('image/') || p.type.startsWith('video/')) return true;
  const path = safePath(url);
  if ((!p.type || p.type.includes('octet-stream')) && MEDIA_EXT_RE.test(path)) return true;
  return false;
}

function safePath(url) {
  try { return new URL(url).pathname; } catch (e) { return ''; }
}

// Copy a GIF exactly. A CDN that is offered JPEG/PNG/WebP will hand back a still
// (or a recompressed animation); asking for the GIF and checking its file header
// keeps every frame.
async function fetchExactGif(url) {
  saveJobs++;
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'qis-offscreen', type: 'exact-gif', url });
    if (!res || typeof res !== 'object') return { network: true };
    if (res.ok && res.url) return { exact: true, url: res.url, type: 'image/gif', sourceUrl: url };
    if (res.tooBig) return { tooBig: true };
    if (res.network) return { network: true };
    return null;
  } catch (e) {
    return { network: true };
  } finally {
    saveJobs--;
    scheduleOffscreenClose();
  }
}

async function choose(candidates) {
  let fallback = null;
  const seen = new Set();
  for (const c of candidates) {
    if (!c || typeof c.url !== 'string' || seen.has(c.url)) continue;
    seen.add(c.url);
    if (c.url.startsWith('data:')) {
      return { url: c.url, type: (c.url.match(/^data:([^;,]+)/) || [])[1] || '', sourceUrl: c.url };
    }
    if (!/^https?:/i.test(c.url)) continue;

    if (QIS.isGifUrl(c.url)) {
      const got = await fetchExactGif(c.url);
      if (got && got.exact) return got;
      if (got && got.tooBig) return { url: c.url, type: 'image/gif', directGif: true, sourceUrl: c.url };
      // Not a GIF body. Keep looking for the real file; remember the page's own URL last.
      if (!c.verify && !fallback) {
        if (got && got.network) fallback = { url: c.url, type: 'image/gif', directGif: true, sourceUrl: c.url };
        else {
          const p = await probe(c.url);
          if (p.networkError) fallback = { url: c.url, type: 'image/gif', directGif: true, sourceUrl: c.url };
          else if (isMediaResponse(p, c.url)) fallback = { url: c.url, type: p.type, sourceUrl: c.url };
        }
      }
      continue;
    }

    const p = await probe(c.url);
    if (p.type === 'image/gif') {
      const got = await fetchExactGif(c.url);
      if (got && got.exact) return got;
      if (got && got.tooBig) return { url: c.url, type: 'image/gif', directGif: true, sourceUrl: c.url };
      if (!(got && got.network)) continue;
    }
    if (isMediaResponse(p, c.url)) return { url: c.url, type: p.type, sourceUrl: c.url };
    if (!c.verify && !fallback) fallback = { url: c.url, type: '', sourceUrl: c.url };
    if (!c.verify && p.networkError) return { url: c.url, type: '', sourceUrl: c.url };
  }
  return fallback;
}

// ---------- file names ----------
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function cleanSegment(s, max) {
  s = String(s || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/[\s.]+$/g, '');
  if (RESERVED.test(s)) s = '_' + s;
  return s;
}

function buildFilename(url, type, hint, kind) {
  const isVideo = kind === 'video' || /^video\//.test(type);
  let name = isVideo ? 'video' : 'image';
  let ext = '';
  if (url.startsWith('data:')) {
    name = 'image-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  } else {
    try {
      const u = new URL(url);
      let seg = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      try { seg = decodeURIComponent(seg); } catch (e) { /* keep raw */ }
      seg = seg.replace(/:[a-z]+$/i, ''); // twitter-style ":large"
      seg = seg.replace(/=[\w-]+$/, '');  // google-style "=s0"
      const m = seg.match(/^(.*)\.([a-z0-9]{2,5})$/i);
      if (m && MEDIA_EXT_RE.test('.' + m[2])) { name = m[1]; ext = m[2].toLowerCase(); }
      else name = seg;
      if (!ext) {
        const f = (u.searchParams.get('format') || u.searchParams.get('fm') || '').toLowerCase();
        if (/^(jpe?g|png|gif|webp|avif)$/.test(f)) ext = f.replace('jpeg', 'jpg');
      }
    } catch (e) { /* keep defaults */ }
  }
  const typeExt = TYPE_EXT[type];
  if (typeExt) {
    const same = SAME_EXT[typeExt] || [typeExt];
    if (!same.includes(ext)) ext = typeExt; // name the file for what it really is
  }
  if (!ext) ext = isVideo ? 'mp4' : 'jpg';
  if (hint) name = hint; // e.g. "natgeo_C9xYz12AbCd" for Instagram
  name = cleanSegment(name, 120) || (isVideo ? 'video' : 'image');
  return `${name}.${ext}`;
}

function folderFor(settings, pageUrl) {
  const parts = String(settings.folder || '')
    .split(/[\\/]+/)
    .map((p) => cleanSegment(p, 60))
    .filter(Boolean);
  if (settings.perSite && pageUrl) {
    try {
      const h = new URL(pageUrl).hostname.replace(/^www\./, '');
      if (h) parts.push(cleanSegment(h, 60));
    } catch (e) { /* ignore */ }
  }
  return parts.join('/');
}

// ---------- downloading ----------
async function download(url, filename, kind) {
  const opts = { url, conflictAction: 'uniquify', saveAs: false };
  if (/^https?:/i.test(url)) {
    // image/gif only — listing JPEG or PNG ahead of it makes CDNs return a still frame.
    if (kind === 'gif' || QIS.isGifUrl(url)) opts.headers = [{ name: 'Accept', value: 'image/gif' }];
    else if (kind !== 'video') opts.headers = [{ name: 'Accept', value: ACCEPT }];
  }
  try {
    return await chrome.downloads.download({ ...opts, filename });
  } catch (e) {
    // If the name was rejected for any reason, let the browser pick one.
    return await chrome.downloads.download(opts);
  }
}

async function bumpCount(n) {
  const { savedCount = 0 } = await chrome.storage.local.get({ savedCount: 0 });
  await chrome.storage.local.set({ savedCount: savedCount + n });
}

async function saveOne(candidates, pageUrl, settings, seen, opts) {
  opts = opts || {};
  const kind = opts.kind === 'video' ? 'video' : 'image';
  const list = Array.isArray(candidates) ? candidates : [];
  const pick = await choose(list);
  if (!pick) return { ok: false, error: `Could not find a downloadable ${kind} here` };
  const savedUrl = pick.sourceUrl || pick.url;
  if (seen) {
    if (seen.has(savedUrl)) return { ok: true, duplicate: true };
    seen.add(savedUrl);
  }
  const gifSave = !!(pick.exact || pick.directGif || pick.type === 'image/gif');
  const hint = (typeof opts.name === 'string' && opts.name) || (gifSave ? QIS.gifFileName(list, savedUrl) : '');
  const file = buildFilename(savedUrl, pick.type, hint, gifSave ? 'image' : kind);
  const folder = folderFor(settings, pageUrl);
  const id = await download(pick.url, folder ? `${folder}/${file}` : file, gifSave ? 'gif' : kind);
  if (pick.exact) pendingBlobs.set(id, pick.url);
  return { ok: true, filename: file, url: savedUrl, quality: gifSave ? 'original' : undefined };
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

// ---------- best-quality videos ----------
// Instagram keeps its sharpest copies as separate picture + sound streams.
// A hidden helper page (offscreen/) picks the best copy and joins the streams.
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;
let saveJobs = 0; // video joins and exact GIF copies still in progress
let closeTimer = 0;
const pendingBlobs = new Map(); // download id -> blob address to free when done

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const found = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (found.length) return;
  } else if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Keep original GIF bytes, and join Instagram video and sound into one file'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function scheduleOffscreenClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (saveJobs || pendingBlobs.size) return;
    chrome.offscreen.closeDocument().catch(() => {});
  }, 30000);
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !pendingBlobs.has(delta.id)) return;
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;
  const url = pendingBlobs.get(delta.id);
  pendingBlobs.delete(delta.id);
  chrome.runtime.sendMessage({ target: 'qis-offscreen', type: 'revoke', url }).catch(() => {});
  scheduleOffscreenClose();
});

const qualityLabel = (w, h) => (w && h ? `${Math.min(w, h)}p` : '');

async function saveVideo(msg, settings, pageUrl) {
  const v = msg.video;
  let best = null;
  if (v && v.dash) {
    saveJobs++;
    try {
      await ensureOffscreen();
      best = await chrome.runtime.sendMessage({
        target: 'qis-offscreen',
        type: 'best-video',
        progressive: { url: v.url, w: v.w, h: v.h },
        dash: v.dash
      });
    } catch (e) {
      best = null; // anything goes wrong: fall back to the single-file version below
    } finally {
      saveJobs--;
      scheduleOffscreenClose();
    }
  }
  if (best && best.use === 'blob' && best.url) {
    const file = `${cleanSegment(msg.name || '', 120) || 'video'}.mp4`;
    const folder = folderFor(settings, pageUrl);
    const id = await download(best.url, folder ? `${folder}/${file}` : file, 'video');
    pendingBlobs.set(id, best.url);
    return { ok: true, filename: file, quality: qualityLabel(best.w, best.h), joined: true };
  }
  const res = await saveOne(msg.candidates, pageUrl, settings, null, { name: msg.name, kind: 'video' });
  if (res.ok && v) res.quality = qualityLabel(v.w, v.h);
  return res;
}

async function handleSave(msg, sender) {
  try {
    const settings = await getSettings();
    const pageUrl = msg.pageUrl || (sender.tab && sender.tab.url) || '';
    const res = msg.kind === 'video' && msg.video
      ? await saveVideo(msg, settings, pageUrl)
      : await saveOne(msg.candidates, pageUrl, settings, null, { name: msg.name, kind: msg.kind });
    if (res.ok) bumpCount(1);
    return res;
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Download failed' };
  }
}

async function handleSaveMany(msg) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  const settings = await getSettings();
  const seen = new Set();
  const total = items.length;
  let done = 0, saved = 0, failed = 0;
  const report = () => chrome.runtime.sendMessage({ type: 'progress', done, total, saved, failed }).catch(() => {});
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        const r = await saveOne(items[i], msg.pageUrl, settings, seen);
        if (r.ok && !r.duplicate) saved++;
        else if (!r.ok) failed++;
      } catch (e) { failed++; }
      done++;
      report();
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (saved) bumpCount(saved);
  return { ok: true, saved, failed, total };
}

// ---------- automatic updates ----------
// New versions are published to GitHub. The extension checks there when the
// browser starts and every few hours. Extensions can't rewrite their own files,
// so a small helper (updater/, turned on once with "Turn on auto-update.bat")
// downloads and installs the new version; then the extension restarts itself.
const UPDATE = {
  manifestUrl: 'https://raw.githubusercontent.com/aduseii/quick-image-saver/main/manifest.json',
  helper: 'com.aduseii.quick_image_saver',
  alarm: 'qis-update-check',
  everyMinutes: 180
};

function isNewer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function askHelper(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(UPDATE.helper, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const missing = /not found|forbidden/i.test(err.message || '');
          resolve({ ok: false, missing, error: missing ? '' : err.message });
        } else {
          resolve(res || { ok: false, error: 'The updater did not answer' });
        }
      });
    } catch (e) {
      resolve({ ok: false, missing: true, error: '' });
    }
  });
}

async function setUpdateBadge(state) {
  const show = state && state.available;
  await chrome.action.setBadgeText({ text: show ? 'NEW' : '' }).catch(() => {});
  if (show) await chrome.action.setBadgeBackgroundColor({ color: '#f2481f' }).catch(() => {});
}

function ensureUpdateAlarm(firstInMinutes) {
  chrome.alarms.get(UPDATE.alarm).then((a) => {
    if (!a) chrome.alarms.create(UPDATE.alarm, { delayInMinutes: firstInMinutes, periodInMinutes: UPDATE.everyMinutes });
  }).catch(() => {});
}

function restartInto(from, to) {
  return chrome.storage.local.set({
    justUpdated: { from, to, at: Date.now() },
    update: { running: to, latest: to, available: false, checkedAt: Date.now(), helper: 'on' }
  }).then(() => chrome.runtime.reload());
}

let updateCheck = null;
function checkForUpdate(manual) {
  if (!updateCheck) updateCheck = runUpdateCheck(!!manual).finally(() => { updateCheck = null; });
  return updateCheck;
}

async function runUpdateCheck(manual) {
  const running = chrome.runtime.getManifest().version;
  const prev = (await chrome.storage.local.get({ update: {} })).update || {};
  const state = { running, latest: prev.latest || null, available: false, checkedAt: Date.now(), helper: prev.helper || 'unknown', error: '' };
  try {
    // New files already on disk (helper finished, or folder replaced by hand)? Restart into them.
    const disk = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (disk && isNewer(disk.version, running)) { await restartInto(running, disk.version); return state; }

    const res = await fetch(`${UPDATE.manifestUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const remote = await res.json();
    if (!remote || remote.name !== 'Quick Image Saver' || !remote.version) throw new Error('Unexpected update file');
    state.latest = remote.version;
    state.available = isNewer(remote.version, running);

    const { autoUpdate } = await chrome.storage.sync.get({ autoUpdate: true });
    if (state.available && autoUpdate) {
      if (saveJobs || pendingBlobs.size) {
        chrome.alarms.create('qis-update-retry', { delayInMinutes: 2 }); // don't restart in the middle of a save
      } else {
        const r = await askHelper({ type: 'update', expect: remote.version });
        if (r.ok && r.version) { await restartInto(running, r.version); return state; }
        state.helper = r.missing ? 'missing' : 'error';
        state.error = r.missing ? '' : (r.error || 'Update failed');
      }
    } else if (manual) {
      const r = await askHelper({ type: 'ping' });
      state.helper = r.ok ? 'on' : r.missing ? 'missing' : 'error';
      if (!r.ok && !r.missing) state.error = r.error || '';
    }
  } catch (e) {
    state.error = (e && e.message) || 'Could not check for updates';
  }
  await chrome.storage.local.set({ update: state });
  await setUpdateBadge(state);
  return state;
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE.alarm || a.name === 'qis-update-retry') checkForUpdate(false);
});
chrome.runtime.onStartup.addListener(() => ensureUpdateAlarm(1));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'check-update') {
    checkForUpdate(true).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'save') {
    handleSave(msg, sender).then(sendResponse);
    return true;
  }
  if (msg.type === 'save-many') {
    handleSaveMany(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

// ---------- keyboard shortcut ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'save-hovered') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'save-hovered' }).catch(() => {});
});

// ---------- install: defaults + start working in already-open tabs ----------
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(current);
  chrome.alarms.clear(UPDATE.alarm).finally(() => ensureUpdateAlarm(1));
  setUpdateBadge(null);
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (/^https:\/\/www\.instagram\.com\//.test(t.url || '')) {
      await chrome.scripting.executeScript({
        target: { tabId: t.id }, files: ['src/ig-main.js'], world: 'MAIN'
      }).catch(() => {});
    }
    chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      files: ['src/resolve.js', 'src/content.js']
    }).catch(() => {});
  }
});
