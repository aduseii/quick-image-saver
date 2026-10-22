/*
 * Quick Image Saver — Instagram helper. Runs in Instagram's own page context.
 *
 * Instagram plays videos from in-memory streams (blob: addresses), so the real
 * video file isn't on the <video> element. This helper:
 *   1. notes the video file addresses inside the data Instagram already loads
 *      (page data + its own network responses), so no extra requests are needed;
 *   2. if a post isn't known yet, asks Instagram's API for that one post.
 * It only reads data; it never changes how Instagram works.
 *
 * The extension's content script talks to it through two DOM events:
 *   "qis:ig-req"  { v, id, code?, pk?, story?, highlight?, duration?, aspect? }
 *   "qis:ig-res"  { v, id, ack? , result? }
 */
(() => {
  'use strict';

  const V = 1;
  if (window.__qisIG === V) return;
  window.__qisIG = V;

  const APP_ID = '936619743392459'; // Instagram web app id (sent by instagram.com itself)
  const MAX_ENTRIES = 4000;
  const nativeFetch = window.fetch;

  const entries = new Map(); // key (pk or "code:XYZ") -> entry, oldest first
  const codeIndex = new Map(); // shortcode -> key
  const noop = () => {};

  // ---------- reading Instagram's data ----------
  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => (Number.isFinite(+v) ? +v : 0);

  function makeEntry(o) {
    const pk = str(o.pk || (o.id != null && String(o.id).split('_')[0]) || '');
    const code = str(o.code || o.shortcode || '');
    let versions = [];
    if (Array.isArray(o.video_versions)) {
      versions = o.video_versions
        .filter((v) => v && typeof v.url === 'string')
        .map((v) => ({ url: v.url, w: num(v.width), h: num(v.height) }));
    } else if (typeof o.video_url === 'string') {
      const d = o.dimensions || {};
      versions = [{ url: o.video_url, w: num(d.width), h: num(d.height) }];
    }
    const owner = o.user || o.owner || {};
    const d = o.dimensions || {};
    // The full quality list (DASH): sharper copies, stored as separate picture + sound streams.
    let dash = '';
    if (typeof o.video_dash_manifest === 'string') dash = o.video_dash_manifest;
    else if (o.dash_info && typeof o.dash_info.video_dash_manifest === 'string') dash = o.dash_info.video_dash_manifest;
    const e = {
      pk,
      code,
      user: str(owner.username || ''),
      duration: num(o.video_duration),
      w: num(o.original_width || d.width),
      h: num(o.original_height || d.height),
      versions,
      dash,
      children: null
    };
    let kids = null;
    if (Array.isArray(o.carousel_media)) kids = o.carousel_media;
    else if (o.edge_sidecar_to_children && Array.isArray(o.edge_sidecar_to_children.edges)) {
      kids = o.edge_sidecar_to_children.edges.map((x) => x && x.node).filter(Boolean);
    }
    if (kids) {
      e.children = kids.map((k, i) => {
        const c = makeEntry(k);
        c.parentCode = code;
        c.index = i;
        c.count = kids.length;
        if (!c.user) c.user = e.user;
        return c;
      });
    }
    return e;
  }

  const isVid = (x) => x.versions.length > 0 || !!x.dash;
  const hasVideo = (e) => !!e && (isVid(e) || (!!e.children && e.children.some(isVid)));

  function merge(prev, e) {
    if (!prev) return e;
    const out = Object.assign({}, prev);
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (k === 'versions') { if (v.length) out.versions = v; continue; } // newest addresses win (they expire)
      if (k === 'dash') { if (v) out.dash = v; continue; }
      if (k === 'children') { if (v && v.length) out.children = v; continue; }
      const empty = out[k] == null || out[k] === '' || out[k] === 0;
      if (empty && v != null && v !== '' && v !== 0) out[k] = v;
    }
    return out;
  }

  function record(e) {
    if (!hasVideo(e) || (!e.pk && !e.code)) return;
    const key = e.pk || 'code:' + e.code;
    const prev = entries.get(key);
    entries.delete(key); // re-insert so the newest data sits last
    entries.set(key, merge(prev, e));
    if (e.code) codeIndex.set(e.code, key);
    if (e.children) {
      for (const c of e.children) if (isVid(c) && c.pk) record(c);
    }
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }

  function scan(node, depth) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) scan(node[i], depth + 1);
      return;
    }
    if (Array.isArray(node.video_versions) || Array.isArray(node.carousel_media) ||
        (typeof node.video_url === 'string' && node.shortcode)) {
      try { record(makeEntry(node)); } catch (err) { /* ignore odd shapes */ }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') scan(v, depth + 1);
    }
  }

  function scanText(text) {
    if (typeof text !== 'string' || (text.indexOf('video_versions') === -1 && text.indexOf('video_url') === -1)) return;
    text = text.replace(/^\s*for\s*\(;;\);/, '');
    try { scan(JSON.parse(text), 0); return; } catch (err) { /* maybe several JSON documents */ }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t[0] !== '{' && t[0] !== '[') continue;
      try { scan(JSON.parse(t), 0); } catch (err) { /* skip */ }
    }
  }

  const scannedScripts = new WeakSet();
  function scanPageData() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      if (scannedScripts.has(s)) continue;
      scannedScripts.add(s);
      scanText(s.textContent);
    }
  }

  // Watch Instagram's own data requests (read-only copies of the responses).
  const isDataUrl = (url) => /\/(graphql|api)\//.test(url) || /\/api\/graphql/.test(url) || /[?&]__a=1/.test(url);

  try {
    window.fetch = function (input, init) {
      const p = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || str(input);
        if (isDataUrl(url)) {
          p.then((res) => {
            try { res.clone().text().then(scanText, noop); } catch (err) { /* ignore */ }
          }, noop);
        }
      } catch (err) { /* never interfere */ }
      return p;
    };
  } catch (err) { /* ignore */ }

  try {
    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;
    const urls = new WeakMap();
    const onLoad = function () {
      try {
        const t = this.responseType;
        if (t === '' || t === 'text') scanText(this.responseText);
        else if (t === 'json') scan(this.response, 0);
      } catch (err) { /* ignore */ }
    };
    XHR.open = function (method, url) {
      try { urls.set(this, str(url)); } catch (err) { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      try { if (isDataUrl(urls.get(this) || '')) this.addEventListener('load', onLoad); } catch (err) { /* ignore */ }
      return send.apply(this, arguments);
    };
  } catch (err) { /* ignore */ }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanPageData, { once: true });
  else scanPageData();

  // ---------- asking Instagram for one post ----------
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function codeToPk(code) {
    if (!code || typeof BigInt !== 'function') return '';
    let id = BigInt(0);
    for (const ch of code.slice(0, 11)) {
      const i = ALPHABET.indexOf(ch);
      if (i < 0) return '';
      id = id * BigInt(64) + BigInt(i);
    }
    return id.toString();
  }

  async function getJson(path) {
    try {
      const res = await nativeFetch.call(window, path, {
        credentials: 'include',
        headers: { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  async function fetchPost(pk) {
    if (!/^\d+$/.test(pk)) return;
    const data = await getJson(`/api/v1/media/${pk}/info/`);
    if (data) scan(data, 0);
  }

  async function fetchHighlight(id) {
    if (!/^\d+$/.test(id)) return;
    const data = await getJson(`/api/v1/feed/reels_media/?reel_ids=highlight%3A${id}`);
    if (data) scan(data, 0);
  }

  // ---------- picking the right video ----------
  function lookup(req) {
    if (req.pk && entries.has(req.pk)) return entries.get(req.pk);
    if (req.code) {
      const key = codeIndex.get(req.code);
      if (key && entries.has(key)) return entries.get(key);
      const pk = codeToPk(req.code);
      if (pk && entries.has(pk)) return entries.get(pk);
    }
    return null;
  }

  function closeness(item, req) {
    let score = 0;
    if (req.duration > 0 && item.duration > 0) score += Math.abs(item.duration - req.duration);
    else score += 0.5;
    const a = item.w && item.h ? item.w / item.h : 0;
    if (req.aspect > 0 && a > 0) score += Math.abs(a - req.aspect) * 2;
    return score;
  }

  function pickInside(entry, req) {
    const vids = entry.children ? entry.children.filter(isVid) : [];
    if (!vids.length) return isVid(entry) ? entry : null;
    if (vids.length === 1) return vids[0];
    if (Number.isInteger(req.index)) {
      const byIndex = vids.find((c) => c.index === req.index);
      if (byIndex) return byIndex;
    }
    return vids.reduce((best, c) => (closeness(c, req) < closeness(best, req) ? c : best));
  }

  // Last resort: the cached video whose length matches what's playing.
  function matchByLength(req) {
    if (!(req.duration > 0)) return null;
    let best = null;
    let bestScore = Infinity;
    for (const e of entries.values()) { // newest last, so ties go to what loaded most recently
      if (!isVid(e) || !(e.duration > 0)) continue;
      const diff = Math.abs(e.duration - req.duration);
      if (diff > 0.35) continue;
      const score = closeness(e, req);
      if (score <= bestScore) { best = e; bestScore = score; }
    }
    return best;
  }

  const SAFE_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;
  function bestUrl(item) {
    const list = item.versions.slice().sort((a, b) => b.w * b.h - a.w * a.h);
    for (const v of list) {
      try {
        const u = new URL(v.url, location.href);
        if (u.protocol === 'https:' && SAFE_HOST.test(u.hostname)) return { url: u.href, w: v.w, h: v.h };
      } catch (err) { /* skip */ }
    }
    return null;
  }

  function fileName(item, req) {
    const user = item.user || 'instagram';
    if (req.story) return `${user}_story_${item.pk || req.pk || 'video'}`;
    const code = item.parentCode || item.code || req.code || item.pk;
    const part = item.parentCode && item.count > 1 ? `_${item.index + 1}` : '';
    return `${user}_${code}${part}`;
  }

  async function resolve(req) {
    scanPageData();
    let entry = lookup(req);
    if (!hasVideo(entry)) {
      if (req.highlight) await fetchHighlight(req.highlight);
      else await fetchPost(req.pk || codeToPk(req.code));
      entry = lookup(req);
    }
    let item = entry ? pickInside(entry, req) : null;
    if (!item) item = matchByLength(req);
    if (!item) return { error: 'Couldn’t find this video — open the post and try again' };
    const best = bestUrl(item);
    if (!best && !item.dash) return { error: 'Couldn’t find this video’s file' };
    return {
      url: best ? best.url : '',
      width: best ? best.w : 0,
      height: best ? best.h : 0,
      dash: item.dash || '',
      name: fileName(item, req)
    };
  }

  document.addEventListener('qis:ig-req', (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (err) { return; }
    if (!req || req.v !== V || !req.id) return;
    const reply = (body) => document.dispatchEvent(new CustomEvent('qis:ig-res', {
      detail: JSON.stringify(Object.assign({ v: V, id: req.id }, body))
    }));
    reply({ ack: true }); // tells the extension a helper is here (sent synchronously)
    resolve(req).then(
      (result) => reply({ result }),
      (err) => reply({ result: { error: str(err && err.message) || 'Something went wrong' } })
    );
  });
})();
