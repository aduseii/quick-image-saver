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

  // Tenor sticks a size code on the end of the media id (…AAAAC = full GIF).
  const TENOR_TRANSPARENT = new Set(['Ai', 'Aj', 'Ak', 'Al', 'Am', 'An', 'At', 'Au', 'Av']);

  function isGifUrl(url) {
    try {
      const u = new URL(url);
      if (/\.gif$/i.test(u.pathname)) return true;
      const fmt = (u.searchParams.get('format') || u.searchParams.get('fm') || '').toLowerCase();
      return fmt === 'gif';
    } catch (e) { return false; }
  }

  // True only for the raw GIF file bytes (GIF87a / GIF89a). A JPEG, WebP or HTML page is not.
  function isGifBytes(buf) {
    if (!buf || buf.length < 6) return false;
    return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61;
  }

  function giphyId(u) {
    const host = u.hostname.toLowerCase();
    if (!/^(i|media\d*)\.giphy\.com$/.test(host)) return '';
    const parts = u.pathname.split('/').filter(Boolean);
    const at = parts.lastIndexOf('media');
    if (at !== -1) {
      let i = at + 1;
      if (parts[i] && /^v1\./.test(parts[i])) i++;
      const id = parts[i];
      if (id && parts[i + 1] && /^[A-Za-z0-9]+$/.test(id)) return id;
    }
    if (parts.length === 1) {
      const m = parts[0].match(/^([A-Za-z0-9]{5,})\.(?:gif|webp|mp4|jpe?g|png)$/i);
      if (m) return m[1];
    }
    return '';
  }

  function tenorOriginals(u) {
    const host = u.hostname.toLowerCase();
    if (!/^(c|media\d*)\.tenor\.com$/.test(host)) return [];
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'images' && parts[1] && /^[A-Za-z0-9]+$/.test(parts[1])) {
      return [`https://media.tenor.com/images/${parts[1]}/tenor.gif`];
    }
    let id = '';
    if (parts[0] === 'm' && parts[1]) id = parts[1];
    else if (parts.length >= 2) id = parts[0];
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return [];
    const coded = id.match(/^(.*)AAA([A-Za-z0-9]{2})$/);
    let full = id;
    let alreadyFull = false;
    if (coded) {
      const target = TENOR_TRANSPARENT.has(coded[2]) ? 'Ai' : 'AC';
      alreadyFull = coded[2] === target;
      full = `${coded[1]}AAA${target}`;
    }
    // media1.tenor.com answers with a web page. c.tenor.com and media.tenor.com serve the file.
    const servesFile = host === 'c.tenor.com' || host === 'media.tenor.com';
    if (alreadyFull && servesFile && /\.gif$/i.test(u.pathname)) return [];
    return [
      `https://c.tenor.com/${full}/tenor.gif`,
      `https://media.tenor.com/${full}/tenor.gif`
    ];
  }

  function imgurGif(u) {
    if (u.hostname.toLowerCase() !== 'i.imgur.com') return [];
    const m = u.pathname.match(/^\/([A-Za-z0-9]{5}|[A-Za-z0-9]{7})([sbtmlh])?\.(gifv?|mp4|webm|gif)$/i);
    if (!m) return [];
    const ext = m[3].toLowerCase();
    if (ext === 'gif' && !m[2]) return [];
    return [`${u.origin}/${m[1]}.gif`];
  }

  // Full-quality GIF addresses for a URL the page is showing. Best first.
  // These are guesses: a preview, a still, or an MP4/WebP stand-in often hides the real GIF.
  function gifOriginals(href) {
    let u;
    try { u = new URL(href); } catch (e) { return []; }
    if (!/^https?:$/.test(u.protocol)) return [];
    const out = [];
    const add = (v) => { if (v && v !== href && !out.includes(v)) out.push(v); };

    const gid = giphyId(u);
    if (gid) {
      // source.gif is the upload. giphy.gif is the full rendition. Never step down from either.
      const file = (u.pathname.split('/').pop() || '').toLowerCase();
      if (file !== 'source.gif') add(`https://media.giphy.com/media/${gid}/source.gif`);
      if (file !== 'source.gif' && file !== 'giphy.gif') add(`https://media.giphy.com/media/${gid}/giphy.gif`);
    }
    for (const t of tenorOriginals(u)) add(t);
    for (const g of imgurGif(u)) add(g);

    const wrapped = u.pathname.match(/^(.*\.gif)\.(?:webp|avif|jpe?g|png)$/i);
    if (wrapped) add(u.origin + wrapped[1] + u.search);

    if (/\.gif$/i.test(u.pathname)) {
      const c = new URL(u.href);
      let changed = false;
      for (const k of [...c.searchParams.keys()]) {
        const low = k.toLowerCase();
        const dropSize = SIZE_PARAMS.includes(low);
        const fmt = low === 'format' || low === 'fm' || low === 'f';
        if (fmt && c.searchParams.get(k) && !/^gif$/i.test(c.searchParams.get(k))) {
          c.searchParams.delete(k);
          changed = true;
        } else if (dropSize) {
          c.searchParams.delete(k);
          changed = true;
        }
      }
      if (changed) add(c.href);
    }
    return out;
  }

  // source.gif, tenor.gif and 200w.gif are real files with useless names.
  const GENERIC_GIF_NAME = /^(source|giphy|tenor|gif|raw|image|preview|thumbnail|thumb|media)$/i;
  const SIZE_GIF_NAME = /^(?:\d{2,4}w?(?:_[sd])?|giphy-downsized(?:-[a-z]+)?|tinygif|nanogif|mediumgif|preview_gif)$/i;

  function gifFileName(candidates, sourceUrl) {
    const baseName = (url) => {
      try {
        let seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
        try { seg = decodeURIComponent(seg); } catch (e) { /* keep raw */ }
        seg = seg.replace(/:[a-z]+$/i, '');
        const m = seg.match(/^(.*)\.[a-z0-9]{2,5}$/i);
        return m ? m[1] : '';
      } catch (e) { return ''; }
    };
    const nice = (n) => n && !GENERIC_GIF_NAME.test(n) && !SIZE_GIF_NAME.test(n);
    const list = Array.isArray(candidates) ? candidates : [];
    for (const pass of [false, true]) {
      for (const c of list) {
        if (!c || typeof c.url !== 'string' || !!c.verify !== pass) continue;
        if (/^(data|blob):/i.test(c.url)) continue;
        const n = baseName(c.url);
        if (nice(n)) return n;
      }
    }
    const src = String(sourceUrl || '');
    const gid = src.match(/\/media\/([A-Za-z0-9]+)\/(?:source|giphy)\.gif/i) || src.match(/i\.giphy\.com\/([A-Za-z0-9]+)\.gif/i);
    if (gid) return gid[1];
    const tid = src.match(/tenor\.com\/(?:images\/)?([A-Za-z0-9_-]{6,})\/tenor\.gif/i);
    if (tid) return tid[1];
    return '';
  }

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

    // A GIF the page shrunk, froze, or swapped for WebP/MP4 — ask for the real file first.
    for (const g of gifOriginals(href)) add(g);

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
      // A Twitter GIF is stored as a video. The thumbnail is one still frame; the MP4 is the file itself.
      if (/^\/tweet_video_thumb\//.test(path)) {
        const id = path.match(/^\/tweet_video_thumb\/([^./]+)/);
        if (id) {
          add(`https://video.twimg.com/tweet_video/${id[1]}.mp4`);
          add(`https://pbs.twimg.com/tweet_video/${id[1]}.mp4`);
        }
      }
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

  const api = {
    abs, parseSrcset, largestFromSrcset, upgrades, looksLikeImageUrl, sourcesForImg,
    candidatesForImg, candidatesForUrl, gifOriginals, gifFileName, isGifUrl, isGifBytes, IMAGE_EXT_RE
  };
  root.QIS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
