// Draws the timestamp / location overlay onto a photo.
// Exposes window.Stamp = { loadMap, render, formatDate, formatDMS, formatHeading }.
(function () {
  'use strict';

  const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif';

  const TILE_SOURCES = [
    { attr: 'Esri', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
    { attr: '© OpenStreetMap', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  ];
  const tileCache = new Map();

  // ---------- formatting

  function tzAbbr(d) {
    let last = '';
    for (const loc of ['en-CA', 'en-US']) {
      try {
        const p = new Intl.DateTimeFormat(loc, { timeZoneName: 'short' }).formatToParts(d)
          .find(x => x.type === 'timeZoneName');
        if (p) { last = p.value; if (!/^(GMT|UTC)/.test(p.value)) return p.value; }
      } catch (e) { /* ignore */ }
    }
    return last;
  }

  // "Oct 13, 2026 at 3:32:24 PM ADT"
  function formatDate(d) {
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      .replace(/ /g, ' ');
    return `${date} at ${time} ${tzAbbr(d)}`.trim();
  }

  // N 45° 34' 46.320"
  function dms(v, pos, neg) {
    const hemi = v >= 0 ? pos : neg;
    const ms = Math.round(Math.abs(v) * 3600 * 1000); // thousandths of an arc-second
    const d = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = (ms % 60000) / 1000;
    return `${hemi} ${d}° ${m}' ${s.toFixed(3)}"`;
  }
  function formatDMS(lat, lon) { return `${dms(lat, 'N', 'S')}, ${dms(lon, 'E', 'W')}`; }

  function formatHeading(h) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const deg = Math.round(h) % 360;
    return `${deg}° ${dirs[Math.round(deg / 45) % 8]}`;
  }

  // ---------- map tiles

  function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const r = lat * Math.PI / 180;
    return {
      x: (lon + 180) / 360 * n,
      y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n,
    };
  }

  function loadTile(src, z, x, y) {
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return Promise.resolve(null);
    const key = `${src.attr}|${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const p = (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(src.url(z, x, y), { mode: 'cors', signal: ctl.signal });
        if (!r.ok) throw new Error('tile ' + r.status);
        return await createImageBitmap(await r.blob());
      } finally { clearTimeout(t); }
    })();
    tileCache.set(key, p);
    p.catch(() => tileCache.delete(key));
    return p;
  }

  // Resolves to { tiles:[{img,dx,dy}], span, attr } or null if no tiles could be loaded.
  async function loadMap(lat, lon, z) {
    const span = 1.6; // map box width, in tiles
    const c = lonLatToTile(lon, lat, z);
    const x0 = Math.floor(c.x - span / 2), x1 = Math.floor(c.x + span / 2);
    const y0 = Math.floor(c.y - span / 2), y1 = Math.floor(c.y + span / 2);
    for (const src of TILE_SOURCES) {
      try {
        const jobs = [];
        for (let tx = x0; tx <= x1; tx++) {
          for (let ty = y0; ty <= y1; ty++) {
            jobs.push(loadTile(src, z, tx, ty).then(img => ({ img, dx: tx - c.x, dy: ty - c.y })));
          }
        }
        return { tiles: await Promise.all(jobs), span, attr: src.attr };
      } catch (e) { /* try next source */ }
    }
    return null;
  }

  // ---------- drawing

  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

  function drawMap(ctx, x, y, S, map) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, S, S); ctx.clip();
    ctx.fillStyle = '#c9d3d8'; ctx.fillRect(x, y, S, S);
    const tp = S / map.span;
    for (const t of map.tiles) {
      if (t.img) ctx.drawImage(t.img, x + S / 2 + t.dx * tp, y + S / 2 + t.dy * tp, tp + 1, tp + 1);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, y, S, S);

    const cx = x + S / 2, cy = y + S / 2;
    ctx.fillStyle = 'rgba(10,132,255,0.22)'; circle(ctx, cx, cy, S * 0.13); ctx.fill();
    ctx.fillStyle = '#fff'; circle(ctx, cx, cy, S * 0.042); ctx.fill();
    ctx.fillStyle = '#0a84ff'; circle(ctx, cx, cy, S * 0.032); ctx.fill();

    ctx.font = `600 ${Math.round(S * 0.05)}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = S * 0.01;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(map.attr, x + S * 0.04, y + S - S * 0.04);
    ctx.restore();
  }

  function drawCompass(ctx, cx, cy, R, heading) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; circle(ctx, cx, cy, R); ctx.fill();
    ctx.lineWidth = R * 0.04; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();

    ctx.lineWidth = R * 0.03;
    for (let a = 0; a < 360; a += 30) {
      const ang = (a - heading) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(ang) * R * 0.84, cy - Math.cos(ang) * R * 0.84);
      ctx.lineTo(cx + Math.sin(ang) * R * 0.95, cy - Math.cos(ang) * R * 0.95);
      ctx.stroke();
    }

    ctx.font = `700 ${Math.round(R * 0.26)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [label, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const ang = (a - heading) * Math.PI / 180;
      ctx.save();
      ctx.translate(cx + Math.sin(ang) * R * 0.64, cy - Math.cos(ang) * R * 0.64);
      ctx.rotate(ang);
      ctx.fillStyle = label === 'N' ? '#ff453a' : '#fff';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    // Needle: the direction the camera was facing (always up).
    ctx.fillStyle = '#2ec5ff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - R * 0.5);
    ctx.lineTo(cx - R * 0.13, cy + R * 0.14);
    ctx.lineTo(cx, cy + R * 0.03);
    ctx.lineTo(cx + R * 0.13, cy + R * 0.14);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawLines(ctx, lines, W, margin, base) {
    const fs = Math.round(base * 0.036);
    const maxW = W - 2 * margin;
    let y = margin;
    ctx.save();
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
    for (const line of lines) {
      let size = fs;
      ctx.font = `500 ${size}px ${FONT}`;
      const w = ctx.measureText(line).width;
      if (w > maxW) { size = Math.floor(size * maxW / w); ctx.font = `500 ${size}px ${FONT}`; }
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = size * 0.18;
      ctx.lineWidth = size * 0.09; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(line, W - margin, y);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.fillText(line, W - margin, y);
      y += size * 1.24;
    }
    ctx.restore();
  }

  // info: { taken: Date, network: Date|null, lat, lon, heading, address: [lines], user, note }
  function render(img, info) {
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);

    const base = Math.min(W, H);
    const margin = Math.round(base * 0.035);

    if (info.map) drawMap(ctx, 0, 0, Math.round(base * 0.30), info.map);

    const lines = [];
    if (info.network) lines.push('Network:' + formatDate(info.network));
    lines.push('Local:' + formatDate(info.taken));
    if (typeof info.lat === 'number') lines.push(formatDMS(info.lat, info.lon));
    else lines.push('Location unavailable');
    if (typeof info.heading === 'number') lines.push(formatHeading(info.heading));
    for (const a of info.address || []) lines.push(a);
    if (info.user) lines.push('Photo by: ' + info.user);
    drawLines(ctx, lines, W, margin, base);

    if (typeof info.heading === 'number') {
      const R = Math.round(base * 0.09);
      drawCompass(ctx, margin + R, H - margin - R, R, info.heading);
    }
    return cv;
  }

  window.Stamp = { loadMap, render, formatDate, formatDMS, formatHeading };
})();
