/*
 * Quick Image Saver — joins separate video and sound streams into one MP4.
 *
 * Instagram keeps its sharpest copies as "DASH" streams: one fragmented MP4
 * file with only the picture and another with only the sound. This file
 * combines them into one ordinary MP4 that plays and edits anywhere.
 *
 * It is lossless: every audio/video frame is copied byte for byte; only the
 * file structure around the frames (the index tables) is rewritten.
 *
 *   QISMux.remux([videoBytes, audioBytes]) -> { blob, tracks }
 */
(function (root) {
  'use strict';

  // ---------- reading ----------
  const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

  function readBoxes(f, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = f.dv.getUint32(p);
      const type = fourcc(f.u8, p + 4);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = Number(f.dv.getBigUint64(p + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) break; // truncated or garbage: stop here
      out.push({ type, start: p, end: p + size, data: p + hdr });
      p += size;
    }
    return out;
  }
  const kids = (f, b) => readBoxes(f, b.data, b.end);
  const find = (list, type) => list.find((b) => b.type === type) || null;
  const findAll = (list, type) => list.filter((b) => b.type === type);
  const u64 = (f, p) => Number(f.dv.getBigUint64(p));
  const rawBox = (f, b) => f.u8.subarray(b.start, b.end);

  function parseTrack(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const f = { u8, dv: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) };
    const top = readBoxes(f, 0, u8.length);
    const moov = find(top, 'moov');
    if (!moov) throw new Error('Stream has no header (moov)');
    const mk = kids(f, moov);

    const mvhd = find(mk, 'mvhd');
    const movieTimescale = mvhd ? f.dv.getUint32(mvhd.data + (u8[mvhd.data] === 1 ? 20 : 12)) || 1000 : 1000;

    const trak = find(mk, 'trak');
    if (!trak) throw new Error('Stream has no track');
    const tk = kids(f, trak);
    const tkhd = find(tk, 'tkhd');
    if (!tkhd) throw new Error('Track has no tkhd');
    const trackId = f.dv.getUint32(tkhd.data + (u8[tkhd.data] === 1 ? 20 : 12));
    const width = f.dv.getUint32(tkhd.end - 8);
    const height = f.dv.getUint32(tkhd.end - 4);

    const mdia = find(tk, 'mdia');
    if (!mdia) throw new Error('Track has no mdia');
    const md = kids(f, mdia);
    const mdhd = find(md, 'mdhd');
    const hdlr = find(md, 'hdlr');
    const minf = find(md, 'minf');
    if (!mdhd || !hdlr || !minf) throw new Error('Track is missing media boxes');
    const mv = u8[mdhd.data];
    const timescale = f.dv.getUint32(mdhd.data + (mv === 1 ? 20 : 12));
    const language = f.dv.getUint16(mdhd.data + (mv === 1 ? 32 : 20));
    const handler = fourcc(u8, hdlr.data + 8);
    const mi = kids(f, minf);
    const stbl = find(mi, 'stbl');
    const sb = stbl ? kids(f, stbl) : [];
    const stsd = find(sb, 'stsd');
    if (!stsd) throw new Error('Track has no codec description');
    const stszIn = find(sb, 'stsz');
    if (stszIn && f.dv.getUint32(stszIn.data + 8) > 0) throw new Error('Not a split (fragmented) stream');
    if (!timescale) throw new Error('Track has no timescale');

    let edits = null;
    const edts = find(tk, 'edts');
    const elst = edts && find(kids(f, edts), 'elst');
    if (elst) {
      const v = u8[elst.data];
      const n = f.dv.getUint32(elst.data + 4);
      edits = [];
      let p = elst.data + 8;
      for (let i = 0; i < n && p < elst.end; i++) {
        if (v === 1) {
          edits.push({ dur: u64(f, p), time: Number(f.dv.getBigInt64(p + 8)), rate: f.dv.getInt16(p + 16), frac: f.dv.getInt16(p + 18) });
          p += 20;
        } else {
          edits.push({ dur: f.dv.getUint32(p), time: f.dv.getInt32(p + 4), rate: f.dv.getInt16(p + 8), frac: f.dv.getInt16(p + 10) });
          p += 12;
        }
      }
    }

    const trex = { dur: 0, size: 0, flags: 0 };
    const mvex = find(mk, 'mvex');
    if (mvex) {
      for (const b of findAll(kids(f, mvex), 'trex')) {
        if (f.dv.getUint32(b.data + 4) !== trackId) continue;
        trex.dur = f.dv.getUint32(b.data + 12);
        trex.size = f.dv.getUint32(b.data + 16);
        trex.flags = f.dv.getUint32(b.data + 20);
      }
    }

    // Walk the fragments (moof + mdat pairs) and list every sample.
    const samples = [];
    const chunks = [];
    let dts = 0;
    for (const moof of top) {
      if (moof.type !== 'moof') continue;
      for (const traf of findAll(kids(f, moof), 'traf')) {
        const tb = kids(f, traf);
        const tfhd = find(tb, 'tfhd');
        if (!tfhd || f.dv.getUint32(tfhd.data + 4) !== trackId) continue;
        const hf = f.dv.getUint32(tfhd.data) & 0xffffff;
        let p = tfhd.data + 8;
        let base = moof.start; // default-base-is-moof, and the rule for a single traf
        if (hf & 0x1) { base = u64(f, p); p += 8; }
        if (hf & 0x2) p += 4;
        let dDur = trex.dur, dSize = trex.size, dFlags = trex.flags;
        if (hf & 0x8) { dDur = f.dv.getUint32(p); p += 4; }
        if (hf & 0x10) { dSize = f.dv.getUint32(p); p += 4; }
        if (hf & 0x20) { dFlags = f.dv.getUint32(p); p += 4; }
        const tfdt = find(tb, 'tfdt');
        if (tfdt) dts = u8[tfdt.data] === 1 ? u64(f, tfdt.data + 4) : f.dv.getUint32(tfdt.data + 4);

        const chunk = { first: samples.length, count: 0, dts };
        let pos = base;
        for (const trun of findAll(tb, 'trun')) {
          const rv = u8[trun.data];
          const rf = f.dv.getUint32(trun.data) & 0xffffff;
          const n = f.dv.getUint32(trun.data + 4);
          let q = trun.data + 8;
          if (rf & 0x1) { pos = base + f.dv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (rf & 0x4) { firstFlags = f.dv.getUint32(q); q += 4; }
          for (let i = 0; i < n; i++) {
            let dur = dDur, size = dSize, flags = dFlags, cto = 0;
            if (rf & 0x100) { dur = f.dv.getUint32(q); q += 4; }
            if (rf & 0x200) { size = f.dv.getUint32(q); q += 4; }
            if (rf & 0x400) { flags = f.dv.getUint32(q); q += 4; } else if (i === 0 && firstFlags !== null) flags = firstFlags;
            if (rf & 0x800) { cto = rv === 0 ? f.dv.getUint32(q) : f.dv.getInt32(q); q += 4; }
            if (pos + size > u8.length) throw new Error('Stream is incomplete');
            samples.push({ off: pos, size, dur, cto, sync: ((flags >>> 16) & 1) === 0, dts });
            pos += size;
            dts += dur;
            chunk.count++;
          }
        }
        if (chunk.count) chunks.push(chunk);
      }
    }
    if (!samples.length) throw new Error('Stream has no frames');

    let mediaDuration = 0;
    for (const s of samples) mediaDuration += s.dur;

    return {
      f, handler, trackId, timescale, language, width, height, movieTimescale, edits,
      stsd: rawBox(f, stsd),
      hdlr: rawBox(f, hdlr),
      minfOther: mi.filter((b) => b.type !== 'stbl').map((b) => rawBox(f, b)),
      samples, chunks, mediaDuration
    };
  }

  // ---------- writing ----------
  function box(type, parts) {
    if (!Array.isArray(parts)) parts = [parts];
    parts = parts.filter(Boolean);
    let len = 8;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function bytes(n, fill) {
    const b = new Uint8Array(n);
    if (fill) fill(new DataView(b.buffer));
    return b;
  }
  const vf = (v, flags) => bytes(4, (d) => d.setUint32(0, ((v << 24) | flags) >>> 0));
  const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  const matrix = () => bytes(36, (d) => MATRIX.forEach((m, i) => d.setUint32(i * 4, m)));

  function runs(values) {
    const out = [];
    for (const v of values) {
      const last = out[out.length - 1];
      if (last && last[1] === v) last[0]++;
      else out.push([1, v]);
    }
    return out;
  }

  function stts(t) {
    const r = runs(t.samples.map((s) => s.dur));
    return box('stts', [vf(0, 0), bytes(4 + r.length * 8, (d) => {
      d.setUint32(0, r.length);
      r.forEach((x, i) => { d.setUint32(4 + i * 8, x[0]); d.setUint32(8 + i * 8, x[1]); });
    })]);
  }

  function ctts(t) {
    if (!t.samples.some((s) => s.cto !== 0)) return null;
    const neg = t.samples.some((s) => s.cto < 0);
    const r = runs(t.samples.map((s) => s.cto));
    return box('ctts', [vf(neg ? 1 : 0, 0), bytes(4 + r.length * 8, (d) => {
      d.setUint32(0, r.length);
      r.forEach((x, i) => {
        d.setUint32(4 + i * 8, x[0]);
        if (neg) d.setInt32(8 + i * 8, x[1]); else d.setUint32(8 + i * 8, x[1]);
      });
    })]);
  }

  function stss(t) {
    const idx = [];
    t.samples.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
    if (!idx.length || idx.length === t.samples.length) return null; // all key frames: no table needed
    return box('stss', [vf(0, 0), bytes(4 + idx.length * 4, (d) => {
      d.setUint32(0, idx.length);
      idx.forEach((v, i) => d.setUint32(4 + i * 4, v));
    })]);
  }

  function stsz(t) {
    const n = t.samples.length;
    return box('stsz', [vf(0, 0), bytes(8 + n * 4, (d) => {
      d.setUint32(0, 0);
      d.setUint32(4, n);
      t.samples.forEach((s, i) => d.setUint32(8 + i * 4, s.size));
    })]);
  }

  function stsc(t) {
    const e = [];
    t.chunks.forEach((c, i) => {
      const last = e[e.length - 1];
      if (!last || last[1] !== c.count) e.push([i + 1, c.count]);
    });
    return box('stsc', [vf(0, 0), bytes(4 + e.length * 12, (d) => {
      d.setUint32(0, e.length);
      e.forEach((x, i) => { d.setUint32(4 + i * 12, x[0]); d.setUint32(8 + i * 12, x[1]); d.setUint32(12 + i * 12, 1); });
    })]);
  }

  function chunkOffsets(t, co64) {
    const offs = t.chunks.map((c) => c.out);
    if (co64) {
      return box('co64', [vf(0, 0), bytes(4 + offs.length * 8, (d) => {
        d.setUint32(0, offs.length);
        offs.forEach((o, i) => d.setBigUint64(4 + i * 8, BigInt(o)));
      })]);
    }
    return box('stco', [vf(0, 0), bytes(4 + offs.length * 4, (d) => {
      d.setUint32(0, offs.length);
      offs.forEach((o, i) => d.setUint32(4 + i * 4, o));
    })]);
  }

  // Negative frame offsets aren't understood by some older players/editors.
  // Make them all positive and move the start with the edit list instead (same result on screen).
  function normalizeOffsets(t) {
    let min = 0;
    for (const s of t.samples) if (s.cto < min) min = s.cto;
    t.ctsShift = -min;
    if (min < 0) for (const s of t.samples) s.cto -= min;
  }

  // Keep each stream's timing exactly as it was in the source.
  function editList(t, movieTs) {
    const D = t.samples[0].dts; // source time where our track's time 0 begins
    const S = t.ctsShift || 0;
    const toMovie = (v, ts) => Math.round((v * movieTs) / ts);
    // End of the last frame on screen (with B-frames that isn't the last frame stored).
    let end = 0;
    for (const s of t.samples) end = Math.max(end, s.dts - D + s.cto + s.dur);
    const out = [];
    if (t.edits && t.edits.length) {
      t.edits.forEach((e, i) => {
        if (e.time === -1) { out.push({ dur: toMovie(e.dur, t.movieTimescale), time: -1, rate: 1, frac: 0 }); return; }
        let time = e.time - D + S;
        if (time < 0) { out.push({ dur: toMovie(-time, t.timescale), time: -1, rate: 1, frac: 0 }); time = 0; }
        const lastMediaEdit = !t.edits.slice(i + 1).some((x) => x.time !== -1);
        const dur = lastMediaEdit || e.dur === 0
          ? toMovie(Math.max(0, end - time), t.timescale)
          : toMovie(e.dur, t.movieTimescale);
        out.push({ dur, time, rate: e.rate || 1, frac: e.frac || 0 });
      });
    } else if (D > 0 || S > 0) {
      if (D > 0) out.push({ dur: toMovie(D, t.timescale), time: -1, rate: 1, frac: 0 });
      out.push({ dur: toMovie(Math.max(0, end - S), t.timescale), time: S, rate: 1, frac: 0 });
    }
    return out.length ? out : null;
  }

  function edts(list) {
    if (!list) return null;
    return box('edts', box('elst', [vf(0, 0), bytes(4 + list.length * 12, (d) => {
      d.setUint32(0, list.length);
      list.forEach((e, i) => {
        d.setUint32(4 + i * 12, e.dur);
        d.setInt32(8 + i * 12, e.time);
        d.setInt16(12 + i * 12, e.rate);
        d.setInt16(14 + i * 12, e.frac);
      });
    })]));
  }

  function trak(t, id, movieTs, co64) {
    const isAudio = t.handler === 'soun';
    const list = editList(t, movieTs);
    const tkDuration = list ? list.reduce((a, e) => a + e.dur, 0) : Math.round((t.mediaDuration * movieTs) / t.timescale);
    t.movieDuration = tkDuration;
    const tkhd = box('tkhd', [vf(0, 3), bytes(80, (d) => {
      d.setUint32(8, id);
      d.setUint32(16, tkDuration);
      d.setUint16(32, isAudio ? 0x0100 : 0);
      MATRIX.forEach((m, i) => d.setUint32(36 + i * 4, m));
      d.setUint32(72, isAudio ? 0 : t.width);
      d.setUint32(76, isAudio ? 0 : t.height);
    })]);
    const mdhd = box('mdhd', [vf(0, 0), bytes(20, (d) => {
      d.setUint32(8, t.timescale);
      d.setUint32(12, Math.min(t.mediaDuration, 0xffffffff));
      d.setUint16(16, t.language);
    })]);
    const stbl = box('stbl', [t.stsd, stts(t), ctts(t), stss(t), stsc(t), stsz(t), chunkOffsets(t, co64)]);
    const hasDinf = t.minfOther.some((b) => fourcc(b, 4) === 'dinf');
    const dinf = hasDinf ? null : box('dinf', box('dref', [vf(0, 0), bytes(4, (d) => d.setUint32(0, 1)), box('url ', vf(0, 1))]));
    const minf = box('minf', [...t.minfOther, dinf, stbl]);
    return box('trak', [tkhd, edts(list), box('mdia', [mdhd, t.hdlr, minf])]);
  }

  function remux(inputs) {
    const tracks = inputs.filter(Boolean).map(parseTrack);
    if (!tracks.length) throw new Error('Nothing to join');
    tracks.forEach(normalizeOffsets);
    tracks.sort((a, b) => (a.handler === 'vide' ? 0 : 1) - (b.handler === 'vide' ? 0 : 1));

    // Interleave fragments by time so players read video and sound together.
    const order = [];
    tracks.forEach((t, ti) => t.chunks.forEach((c) => order.push({ t, c, ti, time: c.dts / t.timescale })));
    order.sort((a, b) => a.time - b.time || a.ti - b.ti);

    let payload = 0;
    for (const o of order) {
      o.rel = payload;
      for (let i = 0; i < o.c.count; i++) payload += o.t.samples[o.c.first + i].size;
    }
    const big = payload + 16 > 0xffffffff;
    const co64 = payload > 0xffffffff - 64 * 1024 * 1024;
    const mdatHeader = big
      ? bytes(16, (d) => { d.setUint32(0, 1); d.setUint32(4, 0x6d646174); d.setBigUint64(8, BigInt(payload + 16)); })
      : bytes(8, (d) => { d.setUint32(0, payload + 8); d.setUint32(4, 0x6d646174); });

    const ftyp = box('ftyp', [new TextEncoder().encode('isom'), bytes(4, (d) => d.setUint32(0, 0x200)),
      new TextEncoder().encode('isomiso2avc1mp41')]);

    const MOVIE_TS = 1000;
    const buildMoov = (mdatStart) => {
      for (const o of order) o.c.out = mdatStart + o.rel;
      const traks = tracks.map((t, i) => trak(t, i + 1, MOVIE_TS, co64));
      const duration = Math.max(...tracks.map((t) => t.movieDuration));
      const mvhd = box('mvhd', [vf(0, 0), bytes(96, (d) => {
        d.setUint32(8, MOVIE_TS);
        d.setUint32(12, duration);
        d.setUint32(16, 0x00010000);
        d.setUint16(20, 0x0100);
        MATRIX.forEach((m, i) => d.setUint32(32 + i * 4, m));
        d.setUint32(92, tracks.length + 1);
      })]);
      return box('moov', [mvhd, ...traks]);
    };
    const sizeProbe = buildMoov(0);
    const moov = buildMoov(ftyp.length + sizeProbe.length + mdatHeader.length);

    const parts = [ftyp, moov, mdatHeader];
    for (const o of order) {
      const { t, c } = o;
      let runStart = -1, runEnd = -1;
      for (let i = 0; i < c.count; i++) {
        const s = t.samples[c.first + i];
        if (s.off === runEnd) { runEnd += s.size; continue; }
        if (runStart >= 0) parts.push(t.f.u8.subarray(runStart, runEnd));
        runStart = s.off;
        runEnd = s.off + s.size;
      }
      if (runStart >= 0) parts.push(t.f.u8.subarray(runStart, runEnd));
    }

    return {
      blob: new Blob(parts, { type: 'video/mp4' }),
      tracks: tracks.map((t) => ({
        kind: t.handler === 'vide' ? 'video' : t.handler === 'soun' ? 'audio' : t.handler,
        width: t.width >>> 16,
        height: t.height >>> 16,
        seconds: t.mediaDuration / t.timescale,
        frames: t.samples.length
      }))
    };
  }

  const api = { remux, parseTrack };
  root.QISMux = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
