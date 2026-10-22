/*
 * Quick Image Saver — finds the highest-quality version of an image.
 *
 * Produces an ordered list of candidate URLs (best first). Each candidate is
 * { url, verify } where verify=true means "this is a guess; only use it if the
 * server confirms it is a real image". The background worker walks the list.
 */
(function (root) {
  'use strict';

  const IMAGE_EXT_RE = /\.(jpe?g|jfif|pjpeg|png|apng|gif|webp|avif|bmp|svg|tiff?|heic|heif|ico)$/i;
  const MAX_CANDIDATES = 10;

  function abs(url, base) {
    if (url == null) return null;
    url = String(url).trim();
    if (!url || /^(javascript|about):/i.test(url)) return null;
    try { return new URL(url, base).href; } catch (e) { return null; }
  }

  function looksLikeImageUrl(href) {
    try {
      const u = new URL(href);
      if (u.protocol === 'data:') return /^data:image\//i.test(href);
      if (IMAGE_EXT_RE.test(u.pathname)) return true;
      if (/^(i\.redd\.it|i\.imgur\.com|pbs\.twimg\.com|i\.pinimg\.com|upload\.wikimedia\.org)$/i.test(u.hostname)) return true;
      if (/(^|\.)googleusercontent\.com$/i.test(u.hostname)) return true;
      if (u.searchParams.has('format') && /^(jpe?g|png|webp|gif|avif)$/i.test(u.searchParams.get('format'))) return true;
      return false;
    } catch (e) { return false; }
  }

  // Spec-style srcset parser. Handles commas inside URLs (e.g. "w_300,h_200").
  function parseSrcset(srcset, base) {
    const out = [];
    if (!srcset) return out;
    const s = String(srcset);
    const n = s.length;
    const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
    let i = 0;
    while (i < n) {
      while (i < n && (isSpace(s[i]) || s[i] === ',')) i++;
      if (i >= n) break;
      let start = i;
      while (i < n && !isSpace(s[i])) i++;
      let url = s.slice(start, i);
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        let depth = 0;
        start = i;
        while (i < n) {
          const c = s[i];
          if (c === '(') depth++;
          else if (c === ')') depth = Math.max(0, depth - 1);
          else if (c === ',' && depth === 0) break;
          i++;
        }
        descriptor = s.slice(start, i).trim();
        i++;
      }
      const href = abs(url, base);
      if (!href) continue;
      let w = 0, x = 0;
      const mw = descriptor.match(/(\d+(?:\.\d+)?)w\b/i);
      const mx = descriptor.match(/(\d*\.?\d+)x\b/i);
      if (mw) w = parseFloat(mw[1]);
      else if (mx) x = parseFloat(mx[1]);
      else x = 1;
      out.push({ url: href, w, x });
    }
    return out;
  }

  function largestFromSrcset(entries) {
    if (!entries.length) return null;
    const withW = entries.filter((e) => e.w > 0);
    const pool = withW.length ? withW : entries;
    const key = withW.length ? 'w' : 'x';
    return pool.reduce((best, e) => (e[key] > best[key] ? e : best)).url;
  }

  const SIZE_PARAMS = [
    'w', 'h', 'width', 'height', 'resize', 'fit', 'crop', 'quality', 'q', 'dpr',
    'size', 'maxwidth', 'maxheight', 'max-w', 'max-h', 'auto', 'fm', 'imwidth',
    'imheight', 'scale', 'sz', 'thumbnail', 'thumb', 'compress', 'ssl'
  ];

  // Known URL patterns that point to a smaller copy, and how to reach the original.
  // Returns guesses, best first.
  function upgrades(href) {
    let u;
    try { u = new URL(href); } catch (e) { return []; }
    if (!/^https?:$/.test(u.protocol)) return [];
    const out = [];
    const add = (v) => { if (v && v !== href && !out.includes(v)) out.push(v); };
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    // Original URL embedded inside a proxy/CDN URL (Substack, Cloudflare, Next.js, wsrv...)
    for (const key of ['url', 'src', 'image', 'img', 'source']) {
      const v = u.searchParams.get(key);
      if (v && (/^https?:\/\//i.test(v) || v.startsWith('/'))) {
        const inner = abs(v, u.origin);
        if (inner && looksLikeImageUrl(inner)) add(inner);
      }
    }
    const embedded = path.match(/\/(https?(?::|%3A)(?:\/\/|%2F%2F).+)$/i);
    if (embedded) {
      try { add(abs(decodeURIComponent(embedded[1]))); } catch (e) { /* ignore */ }
    }
    const cfImage = path.match(/^\/cdn-cgi\/image\/[^/]+\/(.+)$/);
    if (cfImage && !/^https?:/i.test(cfImage[1])) add(`${u.origin}/${cfImage[1]}`);
    const ipx = path.match(/^\/_ipx\/[^/]+\/(.+)$/);
    if (ipx) add(`${u.origin}/${ipx[1]}`);

    // X / Twitter
    if (host === 'pbs.twimg.com') {
      if (/^\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(path)) {
        const c = new URL(u.href);
        const m = c.pathname.match(/^(.*?)\.(jpe?g|png|webp|gif)(?::\w+)?$/i);
        if (m) {
          c.pathname = m[1];
          c.searchParams.set('format', m[2].toLowerCase().replace('jpeg', 'jpg'));
        }
        c.searchParams.set('name', 'orig');
        add(c.href);
      }
      if (/^\/profile_images\//.test(path)) {
        add(u.origin + path.replace(/_(normal|bigger|mini|x96|200x200|400x400)(\.\w+)$/, '$2'));
      }
    }

    // Pinterest
    if (host === 'i.pinimg.com') {
      const m = path.match(/^\/(\d+)x(\d*)\/(.+)$/);
      if (m) {
        add(`${u.origin}/originals/${m[3]}`);
        if (+m[1] < 736) add(`${u.origin}/736x/${m[3]}`);
      }
    }

    // Reddit
    if (host === 'preview.redd.it') {
      let name = path.replace(/^\//, '');
      const v0 = name.lastIndexOf('-v0-');
      if (v0 !== -1) name = name.slice(v0 + 4);
      add(`https://i.redd.it/${name}`);
    }

    // Wikipedia / Wikimedia thumbnails
    if (host === 'upload.wikimedia.org' && path.includes('/thumb/')) {
      const m = path.match(/^(.*)\/thumb\/(.+)\/[^/]+$/);
      if (m) add(`${u.origin}${m[1]}/${m[2]}`);
    }

    // Google-hosted images (Blogger, Google Photos, Play Store, avatars)
    if (/(^|\.)(googleusercontent\.com|ggpht\.com)$/.test(host)) {
      if (/=[\w-]+$/.test(path)) add(u.origin + path.replace(/=[\w-]+$/, '=s0'));
      else if (/\/(?:s\d+|w\d+-h\d+)(?:-[\w-]+)?\//.test(path)) add(u.origin + path.replace(/\/(?:s\d+|w\d+-h\d+)(?:-[\w-]+)?\//, '/s0/'));
      else add(u.origin + path + '=s0');
    }

    // YouTube thumbnails
    if (/^i\d?\.ytimg\.com$/.test(host)) {
      const m = path.match(/^\/(?:vi|vi_webp)\/([^/]+)\/(\w+)\.(?:jpg|webp)$/);
      if (m && m[2] !== 'maxresdefault') add(`https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg`);
    }

    // Imgur ("abcdefgl.jpg" = large thumbnail of "abcdefg.jpg")
    if (host === 'i.imgur.com') {
      const m = path.match(/^\/([a-zA-Z0-9]{5}|[a-zA-Z0-9]{7})[sbtmlh]\.(\w+)$/);
      if (m) add(`${u.origin}/${m[1]}.${m[2]}`);
      else if (u.search) add(u.origin + path);
    }

    // Amazon ("._AC_SX679_.jpg")
    if (/(^|\.)(media-amazon\.com|ssl-images-amazon\.com)$/.test(host)) {
      const p = path.replace(/\._[^/]*_\.(\w+)$/, '.$1');
      if (p !== path) add(u.origin + p);
    }

    // Etsy
    if (host === 'i.etsystatic.com') {
      const p = path.replace(/\/il_\d+x[\dN]+\./, '/il_fullxfull.');
      if (p !== path) add(u.origin + p);
    }

    // eBay
    if (host === 'i.ebayimg.com') {
      const p = path.replace(/\/s-l\d+\./, '/s-l1600.');
      if (p !== path) add(u.origin + p);
    }

    // Medium
    if (host === 'miro.medium.com') {
      const p = path
        .replace(/^\/v2\/(?:[a-z_]+:[^/]+\/)+/i, '/v2/')
        .replace(/^\/(?:max|fit\/c)\/\d+(?:\/\d+)?\//, '/');
      if (p !== path) add(u.origin + p);
    }

    // Cloudinary transformations
    if (host === 'res.cloudinary.com') {
      const m = path.match(/^(\/[^/]+\/image\/(?:upload|fetch))\/((?:[a-z]{1,3}_[^/]+\/)+)(.+)$/);
      if (m) add(u.origin + m[1] + '/' + m[3]);
    }

    // Jetpack / WordPress.com image CDN (i0.wp.com/example.com/pic.jpg)
    const wp = host.match(/^i\d\.wp\.com$/) && path.match(/^\/([^/]+\.[^/]+)\/(.+)$/);
    if (wp) add(`https://${wp[1]}/${wp[2]}`);

    // Shopify ("shirt_300x300.jpg", "shirt_x800@2x.jpg")
    if (host === 'cdn.shopify.com' || path.includes('/cdn/shop/')) {
      const p = path.replace(/_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande)(?:@\dx)?(?:_crop_\w+)?(\.\w+)$/i, '$1');
      if (p !== path) add(u.origin + p + u.search);
    }

    // WordPress-style size suffix ("photo-300x200.jpg") and "-scaled" copies
    const suffix = path.match(/^(.*?)-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|gif|webp|avif))$/i);
    if (suffix) add(u.origin + suffix[1] + suffix[2]);
    const scaled = path.match(/^(.*?)-scaled(\.(?:jpe?g|png|webp))$/i);
    if (scaled) add(u.origin + scaled[1] + scaled[2]);

    // Generic resize parameters (?w=400&q=80)
    const hasSizeParam = [...u.searchParams.keys()].some((k) => SIZE_PARAMS.includes(k.toLowerCase()));
    if (hasSizeParam) {
      const c = new URL(u.href);
      for (const k of [...c.searchParams.keys()]) {
        if (SIZE_PARAMS.includes(k.toLowerCase())) c.searchParams.delete(k);
      }
      add(c.href);
    }

    return out;
  }

  const FULL_SIZE_ATTRS = [
    'data-orig-file', 'data-full', 'data-full-src', 'data-fullsrc', 'data-full-url',
    'data-zoom-image', 'data-zoom-src', 'data-zoom', 'data-hires', 'data-hi-res',
    'data-highres', 'data-large-file', 'data-large', 'data-src-large', 'data-pin-media'
  ];
  const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-original-src', 'data-url', 'data-image'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

  // Real URLs found on the page for an <img>, best first.
  function sourcesForImg(img, base) {
    const out = [];
    const push = (url, verify) => {
      const href = abs(url, base);
      if (href && !out.some((c) => c.url === href)) out.push({ url: href, verify: !!verify });
    };

    // 1. The image is a link to a bigger image (galleries, lightboxes)
    const link = img.closest && img.closest('a[href]');
    if (link) {
      const href = abs(link.getAttribute('href'), base);
      if (href && looksLikeImageUrl(href)) push(href, true);
    }

    // 2. Attributes sites use to point at the full-size file
    for (const attr of FULL_SIZE_ATTRS) {
      const v = img.getAttribute(attr);
      if (v && !/^\s*[{[]/.test(v)) push(v, true);
    }

    // 3. Largest entry across srcset and <picture> sources
    const entries = [];
    const collect = (el) => {
      for (const attr of ['srcset', ...LAZY_SRCSET_ATTRS]) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) entries.push(...parseSrcset(v, base));
      }
    };
    collect(img);
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (picture) picture.querySelectorAll('source').forEach(collect);
    const largest = largestFromSrcset(entries);
    if (largest) push(largest, false);

    // 4. Lazy-load attributes
    for (const attr of LAZY_ATTRS) {
      const v = img.getAttribute(attr);
      if (v && !/^data:image\/(gif|svg)/i.test(v)) push(v, false);
    }

    // 5. What the browser is currently showing
    if (img.currentSrc) push(img.currentSrc, false);
    if (img.src) push(img.src, false);

    // Tiny lazy-load placeholders (data:image/gif, data:image/svg) are never what you want
    const real = out.filter((c) => !/^data:image\/(gif|svg)/i.test(c.url));
    return real.length ? real : out;
  }

  // Expand real sources with upgraded guesses: [guess, guess, real, guess, real, ...]
  function expand(sources) {
    const out = [];
    const push = (c) => { if (!out.some((o) => o.url === c.url)) out.push(c); };
    for (const s of sources) {
      for (const g of upgrades(s.url)) push({ url: g, verify: true });
      push(s);
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out.slice(0, MAX_CANDIDATES);
  }

  function candidatesForImg(img, base) {
    return expand(sourcesForImg(img, base));
  }

  function candidatesForUrl(url, base) {
    const href = abs(url, base);
    return href ? expand([{ url: href, verify: false }]) : [];
  }

  const api = { abs, parseSrcset, largestFromSrcset, upgrades, looksLikeImageUrl, sourcesForImg, candidatesForImg, candidatesForUrl, IMAGE_EXT_RE };
  root.QIS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
