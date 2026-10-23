/*
 * Quick Image Saver — hidden helper page.
 * Picks the sharpest copy of an Instagram video, downloads its picture and
 * sound streams, joins them losslessly (src/mp4mux.js) and hands the finished
 * file back to the background worker as a blob: address to download.
 */
'use strict';

const SAFE_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // beyond this, use the single-file version
const BLOB_LIFETIME = 5 * 60 * 1000;

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && SAFE_HOST.test(url.hostname) ? url.href : null;
  } catch (e) {
    return null;
  }
}

function seconds(iso) {
  const m = /^P(?:\d+D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// Read Instagram's quality list (an MPEG-DASH manifest).
function parseManifest(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const mpd = doc.getElementsByTagName('MPD')[0];
  if (!mpd) return null;
  const out = { video: [], audio: [], duration: seconds(mpd.getAttribute('mediaPresentationDuration')) };
  for (const rep of Array.from(doc.getElementsByTagName('Representation'))) {
    const set = rep.parentElement;
    const attr = (n) => rep.getAttribute(n) || (set && set.getAttribute(n)) || '';
    const base = rep.getElementsByTagName('BaseURL')[0];
    const url = base && safeUrl(base.textContent.trim());
    if (!url) continue;
    const mime = attr('mimeType');
    const type = (set && set.getAttribute('contentType')) || '';
    const item = {
      url,
      w: +rep.getAttribute('width') || 0,
      h: +rep.getAttribute('height') || 0,
      bandwidth: +rep.getAttribute('bandwidth') || 0,
      codecs: attr('codecs'),
      label: rep.getAttribute('FBQualityLabel') || ''
    };
    if (/^video\//.test(mime) || type === 'video' || item.w) out.video.push(item);
    else if (/^audio\//.test(mime) || type === 'audio' || rep.hasAttribute('audioSamplingRate')) out.audio.push(item);
  }
  return out;
}

// Most compatible codec first, for copies of equal sharpness.
function codecRank(c) {
  if (/^(avc1|avc3)/i.test(c)) return 3;
  if (/^(vp09|vp9)/i.test(c)) return 2;
  if (/^av01/i.test(c)) return 1;
  return 0; // HEVC and others: may not play everywhere
}

function pickVideo(list) {
  const playable = list.filter((v) => !/^(hev1|hvc1)/i.test(v.codecs));
  const pool = playable.length ? playable : list;
  return pool.slice().sort((a, b) =>
    b.w * b.h - a.w * a.h || codecRank(b.codecs) - codecRank(a.codecs) || b.bandwidth - a.bandwidth)[0] || null;
}

function pickAudio(list) {
  return list.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
}

async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? +res.headers.get('content-length') || 0 : 0;
  } catch (e) {
    return 0;
  }
}

async function getBytes(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function bestVideo(msg) {
  const prog = msg.progressive && msg.progressive.url ? msg.progressive : null;
  const m = msg.dash ? parseManifest(msg.dash) : null;
  if (!m || !m.video.length) return { use: 'progressive', why: 'no quality list' };
  const v = pickVideo(m.video);
  const a = pickAudio(m.audio);
  const progPixels = prog ? (prog.w || 0) * (prog.h || 0) : 0;
  const dashPixels = v.w * v.h;

  if (prog && progPixels > dashPixels) return { use: 'progressive', why: 'single file is sharper' };
  const estimate = ((v.bandwidth + (a ? a.bandwidth : 0)) * (m.duration || 0)) / 8;
  if (prog && progPixels === dashPixels) {
    // Same size picture: keep whichever carries more detail (more data).
    const progBytes = await headSize(prog.url);
    if (!progBytes || !(estimate > progBytes * 1.05)) return { use: 'progressive', why: 'single file is as good' };
  }
  if (estimate > MAX_BYTES) return { use: 'progressive', why: 'too large to join' };

  const [vBytes, aBytes] = await Promise.all([getBytes(v.url), a ? getBytes(a.url) : null]);
  const joined = QISMux.remux([vBytes, aBytes]);
  const vt = joined.tracks.find((t) => t.kind === 'video') || {};
  const url = URL.createObjectURL(joined.blob);
  setTimeout(() => URL.revokeObjectURL(url), BLOB_LIFETIME);
  return {
    use: 'blob',
    url,
    w: vt.width || v.w,
    h: vt.height || v.h,
    size: joined.blob.size,
    hasAudio: joined.tracks.some((t) => t.kind === 'audio')
  };
}

const MAX_GIF_BYTES = 250 * 1024 * 1024;

// Download the GIF and keep the bytes exactly. Reject anything that is not a GIF
// file (a still JPEG/WebP, or an HTML page), so a save never silently drops frames.
async function exactGif(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return { ok: false }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false };
  let res;
  try {
    res = await fetch(parsed.href, {
      cache: 'no-store',
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'image/gif' }
    });
  } catch (e) {
    return { ok: false, network: true };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/^(text\/|application\/(json|xml|xhtml)|video\/|image\/(jpeg|png|webp|avif|svg))/.test(type)) {
    try { res.body && res.body.cancel(); } catch (e) { /* ignore */ }
    return { ok: false };
  }
  const len = +res.headers.get('content-length') || 0;
  if (len > MAX_GIF_BYTES) {
    try { res.body && res.body.cancel(); } catch (e) { /* ignore */ }
    const maybe = type === 'image/gif' || type === 'application/octet-stream' || type === '';
    return maybe ? { ok: false, tooBig: true } : { ok: false };
  }
  if (!res.body || !res.body.getReader) return { ok: false, network: true };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let head = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (head.length < 6) {
        const take = value.subarray(0, 6 - head.length);
        const next = new Uint8Array(head.length + take.length);
        next.set(head, 0);
        next.set(take, head.length);
        head = next;
      }
      total += value.length;
      if (total > MAX_GIF_BYTES) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        return QIS.isGifBytes(head) ? { ok: false, tooBig: true } : { ok: false };
      }
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, network: true };
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  if (!QIS.isGifBytes(buf)) return { ok: false };
  const blob = new Blob([buf], { type: 'image/gif' });
  const blobUrl = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(blobUrl), BLOB_LIFETIME);
  return { ok: true, url: blobUrl, size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'qis-offscreen') return false;
  if (msg.type === 'exact-gif') {
    exactGif(msg.url).then(sendResponse, () => sendResponse({ ok: false, network: true }));
    return true;
  }
  if (msg.type === 'best-video') {
    bestVideo(msg).then(sendResponse, (e) => sendResponse({ use: 'progressive', why: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'revoke') {
    try { URL.revokeObjectURL(msg.url); } catch (e) { /* ignore */ }
    sendResponse({ ok: true });
  }
  return false;
});
