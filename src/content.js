/*
 * Quick Image Saver — in-page behaviour.
 *  - A small save button appears on the image under the mouse.
 *  - Alt + click on any image saves it.
 *  - Keyboard shortcut (default Alt+Shift+S) saves the image under the mouse.
 */
(() => {
  'use strict';

  // If an older copy is running (extension was updated/reloaded), shut it down first.
  if (window.__qis && typeof window.__qis.destroy === 'function') {
    try { window.__qis.destroy(); } catch (e) { /* ignore */ }
  }

  const R = globalThis.QIS;
  const MIN_SIZE = 64;
  const BTN = 32;
  const settings = { hoverButton: true, altClick: true };
  const cleanups = [];

  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  // ---------- settings ----------
  try {
    chrome.storage.sync.get({ hoverButton: true, altClick: true }).then((s) => {
      Object.assign(settings, s);
      if (!settings.hoverButton) hide(true);
    }).catch(() => {});
    const onStore = (changes, area) => {
      if (area !== 'sync') return;
      for (const k of ['hoverButton', 'altClick']) {
        if (changes[k]) settings[k] = changes[k].newValue;
      }
      if (!settings.hoverButton) hide(true);
    };
    chrome.storage.onChanged.addListener(onStore);
    cleanups.push(() => { try { chrome.storage.onChanged.removeListener(onStore); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }

  // ---------- UI (isolated in a closed shadow root so page CSS can't touch it) ----------
  const ICONS = {
    save: '<svg class="i i-save" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    busy: '<svg class="i i-busy" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="2.4"/><path d="M20 12a8 8 0 0 0-8-8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    done: '<svg class="i i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4 4 9-9.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg class="i i-error" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };

  const host = document.createElement('qis-ui');
  host.style.cssText = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .btn {
        position: fixed; top: 0; left: 0; width: ${BTN}px; height: ${BTN}px;
        margin: 0; padding: 0; border: 0; border-radius: 9px;
        display: grid; place-items: center; cursor: pointer; pointer-events: auto;
        color: #fff; background: rgba(18, 18, 20, .78);
        box-shadow: 0 0 0 1px rgba(255,255,255,.16) inset, 0 4px 14px rgba(0,0,0,.32);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
        opacity: 0; visibility: hidden; transform: scale(.82);
        transition: opacity .12s ease, transform .12s ease, background-color .12s ease, visibility 0s linear .12s;
        outline: none;
      }
      .btn.show { opacity: 1; visibility: visible; transform: scale(1); transition-delay: 0s; }
      .btn:hover { background: #f2481f; }
      .btn:active { transform: scale(.92); }
      .btn:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #f2481f; }
      .btn[data-state="done"] { background: #16a34a; }
      .btn[data-state="error"] { background: #dc2626; }
      .i { width: 18px; height: 18px; display: none; }
      .btn[data-state="idle"] .i-save,
      .btn[data-state="busy"] .i-busy,
      .btn[data-state="done"] .i-done,
      .btn[data-state="error"] .i-error { display: block; }
      .i-busy { animation: spin .7s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .toast {
        position: fixed; left: 50%; bottom: 22px; max-width: min(460px, calc(100vw - 32px));
        display: flex; align-items: center; gap: 9px;
        padding: 9px 14px 9px 11px; border-radius: 999px;
        font: 500 13px/1.3 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
        letter-spacing: .1px; color: #fff; background: rgba(18, 18, 20, .92);
        box-shadow: 0 0 0 1px rgba(255,255,255,.1) inset, 0 8px 26px rgba(0,0,0,.35);
        opacity: 0; transform: translate(-50%, 10px); pointer-events: none;
        transition: opacity .16s ease, transform .16s ease;
      }
      .toast.show { opacity: 1; transform: translate(-50%, 0); }
      .dot { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: #16a34a; }
      .toast.err .dot { background: #dc2626; }
      .toast.wait .dot { background: transparent; }
      .toast.wait .dot svg { width: 16px; height: 16px; display: block; animation: spin .7s linear infinite; }
      .dot svg { width: 12px; height: 12px; display: block; }
      .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .msg b { font-weight: 600; }
    </style>
    <button class="btn" type="button" data-state="idle" title="Save full-size image  (or Alt + click)" aria-label="Save full-size image">
      ${ICONS.save}${ICONS.busy}${ICONS.done}${ICONS.error}
    </button>
    <div class="toast" role="status" aria-live="polite"><span class="dot"></span><span class="msg"></span></div>
  `;
  const btn = shadow.querySelector('.btn');
  const toastEl = shadow.querySelector('.toast');
  const toastDot = shadow.querySelector('.dot');
  const toastMsg = shadow.querySelector('.msg');

  function mount() {
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  // ---------- finding the image under the pointer ----------
  function stackAt(x, y, root, depth) {
    root = root || document;
    depth = depth || 0;
    let list;
    try { list = root.elementsFromPoint(x, y); } catch (e) { return []; }
    if (depth > 3) return list;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (i < 8 && el.shadowRoot && el !== host) {
        for (const inner of stackAt(x, y, el.shadowRoot, depth + 1)) {
          if (!out.includes(inner)) out.push(inner);
        }
      }
      if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  function bigEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  function bgUrl(el) {
    let s;
    try { s = getComputedStyle(el).backgroundImage; } catch (e) { return null; }
    if (!s || s === 'none') return null;
    const m = s.match(/url\((['"]?)(.*?)\1\)/);
    return m ? R.abs(m[2], document.baseURI) : null;
  }

  function imgInside(el, x, y) {
    const imgs = el.getElementsByTagName ? el.getElementsByTagName('img') : [];
    const n = Math.min(imgs.length, 60);
    for (let i = 0; i < n; i++) {
      const img = imgs[i];
      const r = img.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width >= MIN_SIZE && r.height >= MIN_SIZE) {
        const cs = getComputedStyle(img);
        if (cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05) return img;
      }
    }
    return null;
  }

  function findImageIn(stack, x, y) {
    const limit = Math.min(stack.length, 15);
    for (let i = 0; i < limit; i++) {
      const el = stack[i];
      if (el === host || el === document.documentElement || el === document.body) continue;
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (bigEnough(el)) return { el, kind: 'img', index: i };
        continue;
      }
      if (tag === 'PICTURE') {
        const img = el.querySelector('img');
        if (img && bigEnough(img)) return { el: img, kind: 'img', index: i };
        continue;
      }
      if (tag === 'svg' || tag === 'SVG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME') continue;
      const bg = bgUrl(el);
      if (bg && bigEnough(el)) return { el, kind: 'bg', url: bg, index: i };
      if (i < 3) {
        const inner = imgInside(el, x, y);
        if (inner) return { el: inner, kind: 'img', index: i };
      }
    }
    return null;
  }

  function findVideoIn(stack) {
    const limit = Math.min(stack.length, 15);
    for (let i = 0; i < limit; i++) {
      const el = stack[i];
      if (el.tagName === 'VIDEO' && bigEnough(el) && canSaveVideo(el)) return { el, kind: 'video', index: i };
    }
    return null;
  }

  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };

  function urlLooksLikeGif(url) {
    if (!url) return false;
    const s = String(url);
    if (/^data:image\/gif/i.test(s) || /\.gif([?#\s,]|$)/i.test(s)) return true;
    if (/giphy\.com\/media\/[A-Za-z0-9]+\/[^/\s"']+\.(webp|mp4)/i.test(s)) return true;
    if (/i\.giphy\.com\/[A-Za-z0-9]+\.(webp|mp4)/i.test(s)) return true;
    if (/tenor\.com\/\S+\.(webp|mp4|webm)/i.test(s)) return true;
    if (/i\.imgur\.com\/[A-Za-z0-9]+\.gifv([?#\s,]|$)/i.test(s)) return true;
    if (/pbs\.twimg\.com\/tweet_video_thumb\//i.test(s)) return true;
    return false;
  }

  function isGifTarget(found) {
    if (!found) return false;
    if (found.kind === 'bg') return urlLooksLikeGif(found.url);
    if (found.kind === 'img') {
      const el = found.el;
      const bits = [el.currentSrc, el.src, el.getAttribute('srcset'), el.getAttribute('data-src')];
      if (bits.some((s) => urlLooksLikeGif(s))) return true;
      const picture = el.parentElement && el.parentElement.tagName === 'PICTURE' ? el.parentElement : null;
      if (picture) {
        for (const source of picture.querySelectorAll('source')) {
          if (urlLooksLikeGif(source.getAttribute('srcset') || source.getAttribute('src'))) return true;
        }
      }
      return false;
    }
    if (found.kind === 'video') return urlLooksLikeGif(directVideoSrc(found.el));
    return false;
  }

  function findImageAt(x, y) {
    const stack = stackAt(x, y);
    const vid = findVideoIn(stack);
    const img = findImageIn(stack, x, y);
    if (vid && img) {
      // A cover/thumbnail over a video is the same thing: save the video.
      // A much smaller image sitting on top of a video is its own thing: save the image.
      if (img.index < vid.index && area(img.el) < 0.6 * area(vid.el)) return img;
      return vid;
    }
    return vid || img;
  }

  // ---------- videos ----------
  const IG = /(^|\.)instagram\.com$/i.test(location.hostname);

  function directVideoSrc(v) {
    const list = [v.currentSrc, v.src];
    v.querySelectorAll('source').forEach((s) => list.push(s.src));
    for (const u of list) {
      if (u && /^https?:/i.test(u) && !/\.(m3u8|mpd)(\?|#|$)/i.test(u)) return u;
    }
    return null;
  }

  function canSaveVideo(v) {
    return IG || !!directVideoSrc(v);
  }

  // Which Instagram post/reel/story a <video> belongs to.
  const POST_LINK = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{8,})/;
  function codesIn(root) {
    const codes = new Set();
    const links = root.querySelectorAll('a[href]');
    for (let i = 0; i < links.length && i < 300; i++) {
      const m = (links[i].getAttribute('href') || '').match(POST_LINK);
      if (m) codes.add(m[1]);
    }
    return [...codes];
  }

  function igContext(video) {
    const path = location.pathname;
    let m = path.match(/^\/stories\/highlights\/(\d+)/);
    if (m) return { story: true, highlight: m[1] };
    m = path.match(/^\/stories\/[^/]+\/(\d+)/);
    if (m) return { story: true, pk: m[1] };
    const article = video.closest('article');
    if (article) {
      const codes = codesIn(article);
      if (codes.length) return { code: codes[0] };
    }
    m = path.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{8,})/);
    if (m) return { code: m[1] };
    let el = video.parentElement;
    for (let i = 0; el && el !== document.body && i < 14; i++, el = el.parentElement) {
      const codes = codesIn(el);
      if (codes.length === 1) return { code: codes[0] };
      if (codes.length > 1) break;
    }
    return {};
  }

  // Ask the Instagram helper (src/ig-main.js, running in the page) for the video file.
  let igSeq = 0;
  function igAsk(fields) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++igSeq}`;
      let acked = false;
      let timer = 0;
      const done = (value) => {
        document.removeEventListener('qis:ig-res', onRes);
        clearTimeout(timer);
        resolve(value);
      };
      const onRes = (e) => {
        let d;
        try { d = JSON.parse(e.detail); } catch (err) { return; }
        if (!d || d.id !== id) return;
        if (d.ack) { acked = true; return; }
        if ('result' in d) done(d.result || null);
      };
      document.addEventListener('qis:ig-res', onRes);
      document.dispatchEvent(new CustomEvent('qis:ig-req', { detail: JSON.stringify(Object.assign({ v: 1, id }, fields)) }));
      if (!acked) return done(null); // helper not on this page
      timer = setTimeout(() => done({ error: 'Instagram took too long to answer — try again' }), 15000);
    });
  }

  async function videoRequest(video) {
    const direct = directVideoSrc(video);
    if (IG) {
      const ctx = igContext(video);
      const res = await igAsk(Object.assign(ctx, {
        duration: video.duration,
        aspect: video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 0
      }));
      if (res && (res.url || res.dash)) {
        return {
          candidates: res.url ? [{ url: res.url, verify: false }] : [],
          name: res.name,
          video: { url: res.url || '', w: res.width || 0, h: res.height || 0, dash: res.dash || '' }
        };
      }
      if (direct) return { candidates: [{ url: direct, verify: false }] };
      if (!res) throw new Error('Refresh this Instagram page, then try again');
      throw new Error(res.error || 'Couldn’t find this video’s file');
    }
    if (!direct) throw new Error('This video can’t be saved');
    // Giphy, Tenor and Imgur often play a GIF as a small MP4. Ask for the GIF first.
    let originals = [];
    try { originals = R.gifOriginals(direct) || []; } catch (e) { originals = []; }
    return {
      candidates: [
        ...originals.filter((url) => url && url !== direct).map((url) => ({ url, verify: true })),
        { url: direct, verify: false }
      ]
    };
  }

  // ---------- hover button ----------
  let mx = -1, my = -1;
  let pointerInside = false;
  let current = null;
  let rafPending = false;
  let hideTimer = 0;
  let stateTimer = 0;

  function place() {
    if (!current || !current.el.isConnected) return hide();
    const r = current.el.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE || r.bottom < 0 || r.top > innerHeight) return hide();
    const pad = 8;
    let top = Math.max(r.top, 0) + pad;
    let left = Math.min(r.right, innerWidth) - BTN - pad;
    top = Math.min(top, Math.min(r.bottom, innerHeight) - BTN - pad);
    left = Math.max(left, Math.max(r.left, 0) + pad);
    btn.style.top = `${Math.round(top)}px`;
    btn.style.left = `${Math.round(left)}px`;
  }

  function show(found) {
    mount();
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!current || current.el !== found.el) {
      current = found;
      if (btn.dataset.state !== 'busy') setState('idle');
      const label = isGifTarget(found) ? 'Save GIF' : found.kind === 'video' ? 'Save video' : 'Save full-size image';
      btn.title = `${label}  (or Alt + click)`;
      btn.setAttribute('aria-label', label);
    } else {
      current = found;
    }
    place();
    btn.classList.add('show');
  }

  function hide(now) {
    if (now) {
      clearTimeout(hideTimer);
      hideTimer = 0;
      btn.classList.remove('show');
      current = null;
      return;
    }
    if (hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      btn.classList.remove('show');
      current = null;
    }, 140);
  }

  function update() {
    rafPending = false;
    if (!settings.hoverButton || mx < 0) return hide(true);
    const top = stackAt(mx, my)[0];
    if (top === host) { clearTimeout(hideTimer); hideTimer = 0; return; } // pointer is on our button
    const found = findImageAt(mx, my);
    if (found) show(found);
    else hide();
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(update);
  }

  on(document, 'mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
    pointerInside = true;
    if (settings.hoverButton) schedule();
  }, { capture: true, passive: true });

  on(document, 'mouseover', () => { pointerInside = true; }, { capture: true, passive: true });
  on(document, 'mouseout', (e) => {
    if (!e.relatedTarget) { pointerInside = false; hide(); }
  }, { capture: true, passive: true });
  on(window, 'scroll', () => { if (current || settings.hoverButton) schedule(); }, { capture: true, passive: true });
  on(window, 'resize', () => { if (current) schedule(); }, { passive: true });
  on(window, 'blur', () => hide(true));

  on(btn, 'mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  on(btn, 'pointerdown', (e) => e.stopPropagation());
  on(btn, 'click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (current) save(current);
  });

  // ---------- Alt + click ----------
  function altHit(e) {
    if (!settings.altClick || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || e.button !== 0) return null;
    if (e.target === host) return null;
    return findImageAt(e.clientX, e.clientY);
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    on(window, type, (e) => { if (altHit(e)) e.stopImmediatePropagation(); }, true);
  }
  on(window, 'click', (e) => {
    const found = altHit(e);
    if (!found) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    save(found);
  }, true);

  // ---------- saving ----------
  function setState(state) {
    btn.dataset.state = state;
    clearTimeout(stateTimer);
    if (state === 'done' || state === 'error') {
      stateTimer = setTimeout(() => { btn.dataset.state = 'idle'; }, 1400);
    }
  }

  let toastTimer = 0;
  function toast(html, isError, mode) {
    mount();
    const waiting = mode === 'wait';
    toastDot.innerHTML = isError ? ICONS.error : waiting ? ICONS.busy : ICONS.done;
    toastMsg.innerHTML = html;
    toastEl.classList.toggle('err', !!isError);
    toastEl.classList.toggle('wait', waiting);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), waiting ? 60000 : isError ? 3200 : 2400);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function canvasDataUrl(img) {
    try {
      if (!img.naturalWidth) return null;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }

  async function asGifBlob(blob) {
    if (/^image\/gif/i.test(blob.type)) return blob;
    try {
      const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
      if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 &&
          (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
        return new Blob([blob], { type: 'image/gif' });
      }
    } catch (e) { /* keep the original blob */ }
    return blob;
  }

  // blob: URLs only exist inside this page, so turn them into data: URLs first.
  // A GIF drawn onto a canvas is one frame — never do that.
  async function portable(candidates, imgEl) {
    const keepGif = (imgEl && urlLooksLikeGif(imgEl.currentSrc || imgEl.src)) ||
      candidates.some((c) => /^data:image\/gif/i.test(c.url) || /\.gif([?#]|$)/i.test(c.url));
    const out = [];
    for (const c of candidates) {
      if (!c.url.startsWith('blob:')) { out.push(c); continue; }
      try {
        const blob = await asGifBlob(await (await fetch(c.url)).blob());
        out.push({ url: await readAsDataUrl(blob), verify: false });
      } catch (e) {
        if (keepGif) continue;
        const d = imgEl && canvasDataUrl(imgEl);
        if (d) out.push({ url: d, verify: false });
      }
    }
    return out;
  }

  function candidatesFor(found) {
    if (found.kind === 'img') return R.candidatesForImg(found.el, document.baseURI);
    return R.candidatesForUrl(found.url, document.baseURI);
  }

  async function save(found) {
    if (!alive()) {
      toast('Quick Image Saver was updated — <b>refresh this page</b> to keep saving.', true);
      return false;
    }
    const showOnButton = current && current.el === found.el;
    if (showOnButton) setState('busy');
    let slowTimer = 0;
    try {
      let candidates;
      let name = null;
      let video = null;
      if (found.kind === 'video') {
        const req = await videoRequest(found.el);
        candidates = req.candidates;
        name = req.name || null;
        video = req.video || null;
      } else {
        candidates = await portable(candidatesFor(found), found.kind === 'img' ? found.el : null);
      }
      if (!candidates.length && !(video && video.dash)) throw new Error('No image address found');
      if (video && video.dash) {
        slowTimer = setTimeout(() => toast('Getting the best quality…', false, 'wait'), 900);
      } else if (isGifTarget(found)) {
        slowTimer = setTimeout(() => toast('Getting the full GIF…', false, 'wait'), 900);
      }
      const res = await chrome.runtime.sendMessage({
        type: 'save', candidates, pageUrl: location.href, name, video, kind: found.kind === 'video' ? 'video' : 'image'
      });
      clearTimeout(slowTimer);
      if (res && res.ok) {
        if (showOnButton) setState('done');
        toast(`Saved <b>${esc(res.filename)}</b>${res.quality ? ` · ${esc(res.quality)}` : ''}`);
        return true;
      }
      throw new Error((res && res.error) || 'Could not save this image');
    } catch (err) {
      clearTimeout(slowTimer);
      if (showOnButton) setState('error');
      const msg = /context invalidated/i.test(String(err && err.message))
        ? 'Quick Image Saver was updated — <b>refresh this page</b> to keep saving.'
        : esc((err && err.message) || 'Could not save this image');
      toast(msg, true);
      return false;
    }
  }

  // ---------- "save all on page" (popup) ----------
  function collectAll() {
    const items = [];
    const seen = new Set();
    for (const img of Array.from(document.images)) {
      const r = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, r.width);
      const h = Math.max(img.naturalHeight || 0, r.height);
      if (w < 100 || h < 100) continue;
      const cands = R.candidatesForImg(img, document.baseURI).filter((c) => !c.url.startsWith('blob:'));
      if (!cands.length) continue;
      const key = cands[cands.length - 1].url;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(cands);
    }
    return items;
  }

  const onMessage = (msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'collect-all') {
      if (window.top !== window) return false;
      sendResponse({ items: collectAll() });
      return false;
    }
    if (msg.type === 'save-hovered') {
      if (!pointerInside || mx < 0) return false;
      const found = findImageAt(mx, my);
      if (!found) return false;
      save(found);
      sendResponse({ handled: true });
      return false;
    }
    return false;
  };
  try {
    chrome.runtime.onMessage.addListener(onMessage);
    cleanups.push(() => { try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }

  window.__qis = {
    destroy() {
      cleanups.splice(0).forEach((fn) => fn());
      clearTimeout(hideTimer);
      clearTimeout(toastTimer);
      host.remove();
    }
  };
})();
