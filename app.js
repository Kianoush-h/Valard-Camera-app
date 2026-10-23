// Valard Camera: capture → stamp → approve → queue → upload to Power Automate flow.
(function () {
  'use strict';

  const CFG = window.VALARD_CONFIG || {};
  const ZOOM = CFG.MAP_ZOOM || 16;
  const $ = id => document.getElementById(id);

  const store = {
    get(k) { try { return localStorage.getItem('vc.' + k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem('vc.' + k, v); } catch (e) { /* ignore */ } },
  };
  const settings = () => ({ name: store.get('name'), pin: store.get('pin') });

  // Upload address: built into the app (lightly scrambled). PINs are checked by the flow.
  // pins.json (written by admin.html) maps each PIN to the person's name. It stores only a
  // PBKDF2 hash of each PIN, and the name encrypted with that PIN.
  const flowUrl = () => {
    if (CFG.FLOW_X) { try { return atob(CFG.FLOW_X).split('').reverse().join(''); } catch (e) { /* bad config */ } }
    return (CFG.FLOW_URL || '').trim();
  };

  const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join('');

  async function loadPins() {
    try {
      const r = await fetch('pins.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.salt && j.iter && j.entries ? j : null;
    } catch (e) {
      return null;
    }
  }

  // Resolves to { name } for a known PIN, null for an unknown PIN, undefined when offline.
  async function lookupPin(pin) {
    if (!pin || !(window.crypto && crypto.subtle)) return null;
    const pins = await loadPins();
    if (!pins) return undefined;
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: b64bytes(pins.salt), iterations: pins.iter, hash: 'SHA-256' }, base, 512));
    const entry = pins.entries[hex(bits.slice(0, 16))];
    if (!entry) return null;
    try {
      const key = await crypto.subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64bytes(entry.iv) }, key, b64bytes(entry.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
      return null;
    }
  }

  // Resolves to 'ok', 'wrong' or 'offline'.
  async function signIn(pin) {
    const who = await lookupPin(pin);
    if (who === undefined) return 'offline';
    if (!who || !who.name) return 'wrong';
    store.set('pin', pin); store.set('name', who.name);
    return 'ok';
  }

  // On launch: re-check the saved PIN (picks up name changes, signs out removed PINs).
  async function refreshAccess() {
    const s = settings();
    if (!s.pin) return;
    if ((await signIn(s.pin)) === 'wrong') {
      store.set('pin', ''); store.set('name', '');
      state.revoked = true;
    }
  }

  const state = {
    pos: null,
    heading: null, headingAt: 0, compassListening: false,
    timeOffset: null,
    addr: null,           // { at:[lat,lon], lines:[] }
    placeTry: 0, placeAt: null,
    shotHeading: null,
    current: null,        // { blob, url, item } awaiting approval
    uploading: false, uploadProgress: '', pinError: false,
    geoStarted: false,
  };

  // ---------- UI helpers

  // Screen changes, toasts and overlays are animated in ui.js.
  const show = id => UI.go(id);
  const toast = (msg, opts) => UI.toast(msg, opts);
  const busy = msg => UI.busy(msg);
  function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(t));
  }
  function distM(a1, o1, a2, o2) {
    const r = Math.PI / 180, R = 6371000;
    const x = (o2 - o1) * r * Math.cos((a1 + a2) / 2 * r), y = (a2 - a1) * r;
    return Math.sqrt(x * x + y * y) * R;
  }
  const pad = n => String(n).padStart(2, '0');

  // ---------- location

  function setGps(level, text) {
    $('gps-dot').className = 'dot ' + level;
    $('gps-text').textContent = text;
  }

  // Live clock on the home screen: exactly what will be stamped.
  function tickClock() {
    const d = new Date();
    $('clock-time').textContent = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\u202f/g, ' ');
    const tz = Stamp.formatDate(d).split(' ').pop(); // "... 3:32:24 PM ADT" -> "ADT"
    $('clock-date').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + tz;
    const h = d.getHours();
    const first = (settings().name || '').split(' ')[0];
    $('hello').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (first ? ', ' + first : '');
  }

  function startGeo() {
    if (state.geoStarted) return;
    state.geoStarted = true;
    if (!('geolocation' in navigator)) { setGps('bad', 'No GPS'); return; }
    navigator.geolocation.watchPosition(p => {
      state.pos = p;
      const acc = Math.round(p.coords.accuracy);
      setGps(acc <= 25 ? 'good' : acc <= 100 ? 'ok' : 'bad', `GPS ±${acc} m`);
      $('coords-text').textContent = Stamp.formatDMS(p.coords.latitude, p.coords.longitude);
      prefetchPlace(p.coords.latitude, p.coords.longitude);
    }, e => {
      if (e.code === 1) {
        setGps('bad', 'Location blocked');
        $('addr-text').textContent = 'Location is off';
        $('coords-text').textContent = 'Allow it in iPhone Settings › Privacy › Location Services';
      } else {
        setGps('ok', 'GPS searching');
      }
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
  }

  function freshPosition() {
    const p = state.pos;
    if (p && Date.now() - p.timestamp < 30000) return Promise.resolve(p);
    if (!('geolocation' in navigator)) return Promise.resolve(p);
    return new Promise(res => navigator.geolocation.getCurrentPosition(
      np => { state.pos = np; res(np); }, () => res(p),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }));
  }

  async function geocode(lat, lon) {
    const u = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en'
      + `&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
    const r = await fetchT(u, {}, 6000);
    if (!r.ok) throw new Error('geocode ' + r.status);
    const a = (await r.json()).address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || '';
    const iso = a['ISO3166-2-lvl4'] || '';
    const region = iso.includes('-') ? iso.split('-')[1] : (a.state || '');
    const line2 = [city, region, a.postcode].filter(Boolean).join(' ');
    return [street, line2, a.country].filter(Boolean);
  }

  // Warm up the address + map tiles while the user is on the home screen.
  function prefetchPlace(lat, lon) {
    if (state.placeAt && distM(lat, lon, state.placeAt[0], state.placeAt[1]) < 25) return;
    if (Date.now() - state.placeTry < 15000) return;
    state.placeTry = Date.now();
    geocode(lat, lon).then(lines => {
      state.addr = { at: [lat, lon], lines };
      state.placeAt = [lat, lon];
      UI.updateText($('addr-text'), lines.join(', '));
    }).catch(() => { /* retry on a later fix */ });
    Stamp.loadMap(lat, lon, ZOOM).catch(() => {});
  }

  async function addressFor(lat, lon) {
    if (state.addr && distM(lat, lon, state.addr.at[0], state.addr.at[1]) < 40) return state.addr.lines;
    try {
      const lines = await geocode(lat, lon);
      state.addr = { at: [lat, lon], lines };
      return lines;
    } catch (e) {
      return state.addr && distM(lat, lon, state.addr.at[0], state.addr.at[1]) < 300 ? state.addr.lines : [];
    }
  }

  // ---------- network time

  async function syncTime() {
    try {
      const t0 = Date.now();
      const r = await fetchT('manifest.webmanifest?nt=' + t0, { method: 'HEAD', cache: 'no-store' }, 5000);
      const t1 = Date.now();
      const d = Date.parse(r.headers.get('date') || '');
      if (!isNaN(d)) state.timeOffset = d + 500 - (t0 + t1) / 2; // Date header is truncated to seconds
    } catch (e) { /* offline: no network time line */ }
  }

  // ---------- compass

  function onOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h === null) return;
    const so = (screen.orientation && screen.orientation.angle) || (typeof window.orientation === 'number' ? window.orientation : 0);
    state.heading = ((h + so) % 360 + 360) % 360;
    state.headingAt = Date.now();
    $('compass-enable').hidden = true;
    $('compass-text').textContent = Stamp.formatHeading(state.heading);
    UI.setHeading(state.heading);
  }

  function listenCompass() {
    if (state.compassListening) return;
    state.compassListening = true;
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }

  function needsCompassPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  // Must be called from a tap (iOS requirement).
  function requestCompass() {
    if (!needsCompassPermission()) { listenCompass(); return; }
    DeviceOrientationEvent.requestPermission().then(r => {
      if (r === 'granted') listenCompass();
      else $('compass-text').textContent = 'Compass off';
    }).catch(() => {});
  }

  function initCompass() {
    if (!('DeviceOrientationEvent' in window)) { $('compass-text').textContent = 'No compass'; return; }
    listenCompass(); // works if permission was already granted, or on Android
    setTimeout(() => {
      if (state.heading === null && needsCompassPermission()) {
        $('compass-text').textContent = 'Compass off';
        $('compass-enable').hidden = false;
      }
    }, 1500);
  }

  // ---------- capture

  function loadImage(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not read the photo'));
      img.src = URL.createObjectURL(file);
    });
  }

  // Everything known at the moment of the shot. Stored with the raw photo so stamping can run later.
  function shotContext(file) {
    const taken = file.lastModified && Math.abs(Date.now() - file.lastModified) < 600000 ? file.lastModified : Date.now();
    const p = state.pos && Date.now() - state.pos.timestamp < 30000 ? state.pos : null;
    let network = null;
    if (state.timeOffset !== null) network = Math.abs(state.timeOffset) >= 2000 ? taken + state.timeOffset : taken;
    return {
      taken, network, heading: state.shotHeading, user: settings().name,
      pos: p ? { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy } : null,
    };
  }

  function makeItem(raw, ctx, ext = 'jpg') {
    const taken = new Date(ctx.taken);
    const folder = `${taken.getFullYear()}-${pad(taken.getMonth() + 1)}-${pad(taken.getDate())}`;
    const who = (ctx.user || 'user').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `${folder}_${pad(taken.getHours())}${pad(taken.getMinutes())}${pad(taken.getSeconds())}_${who}_${rand}.${ext}`;
    return {
      id: Date.now() + '-' + rand, created: Date.now(), folder, filename,
      status: 'stamping', raw, ctx, meta: { user: ctx.user, takenAt: taken.toISOString() },
    };
  }

  const MAX_BYTES = 2 * 1024 * 1024;
  const toJpeg = (cv, q) => new Promise((res, rej) => cv.toBlob(
    b => b ? res(b) : rej(new Error('Could not create image')), 'image/jpeg', q));

  function scaled(cv, maxW) {
    const k = Math.min(1, maxW / cv.width);
    const s = document.createElement('canvas');
    s.width = Math.round(cv.width * k); s.height = Math.round(cv.height * k);
    s.getContext('2d').drawImage(cv, 0, 0, s.width, s.height);
    return s;
  }

  // Best-quality JPEG under 2 MB: lower the quality first, then shrink 15% at a time.
  async function encodeUnder2MB(canvas) {
    let cv = canvas, blob;
    for (;;) {
      for (const q of [CFG.JPEG_QUALITY || 0.9, 0.8, 0.7, 0.6]) {
        blob = await toJpeg(cv, q);
        if (blob.size <= MAX_BYTES) break;
      }
      if (blob.size <= MAX_BYTES || cv.width < 1200) break;
      const next = scaled(cv, cv.width * 0.85);
      if (cv !== canvas) cv.width = cv.height = 0;
      cv = next;
    }
    if (cv !== canvas) cv.width = cv.height = 0;
    return blob;
  }

  // Adds the stamp and compresses. One photo at a time: full-size canvases are heavy on iPhone.
  let stampChain = Promise.resolve();
  function stamp(raw, ctx) {
    const job = stampChain.then(() => stampNow(raw, ctx));
    stampChain = job.catch(() => {});
    return job;
  }

  async function stampNow(raw, ctx) {
    let img = null;
    try {
      let pos = ctx.pos;
      if (!pos) {
        const p = await freshPosition();
        if (p) pos = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
      }
      const lat = pos ? pos.latitude : undefined;
      const lon = pos ? pos.longitude : undefined;
      const [image, address, map] = await Promise.all([
        loadImage(raw),
        pos ? addressFor(lat, lon) : Promise.resolve([]),
        pos ? Stamp.loadMap(lat, lon, ZOOM).catch(() => null) : Promise.resolve(null),
      ]);
      img = image;
      const taken = new Date(ctx.taken);
      const canvas = Stamp.render(img, {
        taken, network: ctx.network ? new Date(ctx.network) : null, lat, lon, heading: ctx.heading, address, map, user: ctx.user,
      });
      const blob = await encodeUnder2MB(canvas);
      const small = scaled(canvas, 720);
      const thumb = await toJpeg(small, 0.72); // kept 48 h for the Recent photos list
      small.width = small.height = 0;
      canvas.width = canvas.height = 0; // release memory on iOS

      const meta = { user: ctx.user, takenAt: taken.toISOString(), address: address.join(', ') };
      if (pos) { meta.latitude = lat; meta.longitude = lon; meta.accuracy = Math.round(pos.accuracy); }
      if (typeof ctx.heading === 'number') meta.heading = Math.round(ctx.heading);
      return { blob, thumb, meta };
    } finally {
      if (img) URL.revokeObjectURL(img.src);
    }
  }

  // Saves the stamped result over the raw photo, then hands it to the upload queue.
  const stampingIds = new Set();
  function finishStamp(item, job) {
    stampingIds.add(item.id);
    job.then(r => DB.put(Object.assign(item, r, { status: 'pending', raw: null })))
      .catch(() => DB.put(Object.assign(item, { status: 'failed' })).catch(() => {}))
      .finally(() => { stampingIds.delete(item.id); refreshBanner(); processQueue(); });
  }

  // Photos approved before the app was closed resume stamping on the next launch.
  async function resumeStamping() {
    try {
      for (const it of await DB.all()) {
        if (it.status === 'stamping' && it.raw && !stampingIds.has(it.id)) finishStamp(it, stamp(it.raw, it.ctx));
      }
    } catch (e) { /* IndexedDB unavailable */ }
  }

  // Shows the photo straight away; the stamped version replaces it when ready.
  function openPreview(file) {
    clearPreview();
    const ctx = shotContext(file);
    const cur = { item: makeItem(file, ctx), urls: [URL.createObjectURL(file)], result: null };
    cur.job = stamp(file, ctx);
    cur.job.then(r => {
      cur.result = r;
      if (state.current !== cur) return;
      const u = URL.createObjectURL(r.blob);
      cur.urls.push(u);
      $('preview-img').src = u;
      $('preview-note').hidden = true;
      $('save-copy').disabled = false;
    }).catch(() => {
      if (state.current === cur) $('preview-note').textContent = 'Could not add the stamp';
    });
    state.current = cur;
    $('preview-img').src = cur.urls[0];
    $('preview-dest').textContent = `Photos › ${cur.item.folder}`;
    $('preview-note').textContent = 'Adding stamp…';
    $('preview-note').hidden = false;
    $('save-copy').disabled = true;
    show('preview');
  }

  // Videos are uploaded as recorded (no stamp). The flow accepts at most 100 MB per request and
  // base64 adds a third, so 70 MB (about 1 minute at the iPhone default) is the limit.
  const MAX_VIDEO_BYTES = 70 * 1024 * 1024;
  const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

  // First frame as a JPEG for the Recent list; null if the phone can't decode it.
  function videoThumb(file) {
    return new Promise(res => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      const done = b => { clearTimeout(t); v.removeAttribute('src'); URL.revokeObjectURL(url); res(b); };
      const t = setTimeout(() => done(null), 8000);
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadedmetadata = () => { v.currentTime = Math.min(0.1, v.duration || 0); };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          const k = Math.min(1, 720 / v.videoWidth);
          c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          toJpeg(c, 0.72).then(done, () => done(null));
        } catch (e) { done(null); }
      };
      v.onerror = () => done(null);
      v.src = url;
    });
  }

  function openVideo(file) {
    if (file.size > MAX_VIDEO_BYTES) {
      toast(`Video is too large (${mb(file.size)}). Keep it under about 1 minute.`, { ms: 5000, error: true });
      return;
    }
    clearPreview();
    const ctx = shotContext(file);
    const ext = /mp4/.test(file.type) ? 'mp4' : 'mov';
    const item = makeItem(file, ctx, ext);
    item.kind = 'video';
    const meta = Object.assign({}, item.meta, { kind: 'video' });
    if (ctx.pos) { meta.latitude = ctx.pos.latitude; meta.longitude = ctx.pos.longitude; meta.accuracy = Math.round(ctx.pos.accuracy); }
    const cur = { item, kind: 'video', urls: [URL.createObjectURL(file)], result: { blob: file, thumb: null, meta } };
    cur.thumbJob = videoThumb(file);
    state.current = cur;
    $('preview-img').hidden = true;
    $('preview-video').hidden = false;
    $('preview-video').src = cur.urls[0];
    $('preview-dest').textContent = `Photos › ${item.folder}`;
    $('preview-note').textContent = `Video · ${mb(file.size)}`;
    $('preview-note').hidden = false;
    $('save-copy').disabled = false;
    show('preview');
  }

  function clearPreview() {
    if (state.current) state.current.urls.forEach(u => URL.revokeObjectURL(u));
    state.current = null;
    $('preview-img').removeAttribute('src');
    $('preview-img').hidden = false;
    const v = $('preview-video');
    v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
  }

  // Opens the iOS share sheet ("Save Image") or downloads as a fallback. Must run inside a tap.
  function saveToPhone(item) {
    const file = new File([item.blob], item.filename, { type: item.blob.type || 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file] }).catch(() => {});
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(item.blob);
    a.download = item.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return Promise.resolve();
  }

  // ---------- upload queue (IndexedDB, survives app restarts)

  const DB = {
    p: null,
    open() {
      return this.p || (this.p = new Promise((res, rej) => {
        const r = indexedDB.open('valard-camera', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('queue', mode);
        const req = fn(tx.objectStore('queue'));
        tx.oncomplete = () => res(req.result);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    },
    put(item) { return this.run('readwrite', s => s.put(item)); },
    all() { return this.run('readonly', s => s.getAll()); },
    del(id) { return this.run('readwrite', s => s.delete(id)); },
  };

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function upload(item) {
    const body = Object.assign({}, item.meta, {
      pin: settings().pin,
      folder: item.folder,
      filename: item.filename,
      content: await blobToBase64(item.blob),
    });
    try {
      const r = await fetchT(flowUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, Math.max(180000, item.blob.size / 100)); // ms: ~100 KB/s minimum
      if (r.ok) return 'ok';
      if (r.status === 401 || r.status === 403) return 'pin';
      return 'error';
    } catch (e) {
      return 'error';
    }
  }

  async function processQueue() {
    if (state.uploading || !flowUrl()) return;
    state.uploading = true;
    try {
      const items = (await DB.all()).filter(it => !['uploaded', 'stamping', 'failed'].includes(it.status)).sort((a, b) => a.created - b.created);
      for (let i = 0; i < items.length; i++) {
        if (navigator.onLine === false) break;
        state.uploadProgress = `Uploading ${i + 1} of ${items.length}…`;
        state.uploadingId = items[i].id;
        refreshBanner();
        const res = await upload(items[i]);
        if (res === 'ok') {
          // keep a thumbnail for the history list; drop the full photo
          await DB.put(Object.assign(items[i], { status: 'uploaded', uploadedAt: Date.now(), blob: null }));
          state.pinError = false;
          toast('Uploaded to SharePoint');
          UI.pop($('sync-ic'));
        } else {
          if (res === 'pin') state.pinError = true;
          break; // try again later
        }
      }
    } catch (e) {
      /* IndexedDB problem; retry later */
    } finally {
      state.uploading = false;
      state.uploadingId = null;
      state.uploadProgress = '';
      refreshBanner();
    }
  }

  async function refreshBanner() {
    let items = [];
    try { items = await DB.all(); } catch (e) { /* ignore */ }
    // Uploaded photos stay listed for 48 h; unsent photos are never removed.
    const cutoff = Date.now() - 48 * 3600e3;
    for (const it of items) if (it.status === 'uploaded' && it.created < cutoff) DB.del(it.id).catch(() => {});
    items = items.filter(it => it.status !== 'uploaded' || it.created >= cutoff);
    renderRecent(items);
    const n = items.filter(it => it.status !== 'uploaded').length;
    const plural = `${n} photo${n > 1 ? 's' : ''}`;
    let msg, kind, icon;
    if (state.pinError && n) { msg = `Upload rejected: your PIN is not active in the flow (${plural} waiting)`; kind = 'error'; icon = 'i-alert'; }
    else if (state.uploading && state.uploadProgress) { msg = state.uploadProgress; kind = 'uploading'; icon = 'i-cloud'; }
    else if (n) {
      msg = navigator.onLine === false ? `${plural} waiting. Will upload when you have signal` : `${plural} waiting to upload`;
      kind = 'pending'; icon = 'i-cloud';
    } else if (!flowUrl()) { msg = 'Not connected to SharePoint'; kind = 'pending'; icon = 'i-alert'; }
    else { msg = 'All photos uploaded'; kind = 'ok'; icon = 'i-check'; }
    $('sync').className = 'sync ' + kind;
    $('sync-ic').innerHTML = `<use href="#${icon}"/>`;
    $('queue-banner').textContent = msg;
    $('set-queue').textContent = n ? `${n} photo${n > 1 ? 's' : ''} waiting to upload.` : 'All photos uploaded.';
  }

  // ---------- recent photos (last 48 h) and photo popup

  const thumbUrls = new Map();
  const fmtTime = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');
  function fmtWhen(t) {
    const d = new Date(t);
    const day = d.toDateString() === new Date().toDateString() ? 'Today'
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return `${day}, ${fmtTime(t)}`;
  }
  const takenAt = it => (it.meta && it.meta.takenAt ? Date.parse(it.meta.takenAt) : it.created);

  function statusOf(it) {
    if (it.status === 'uploaded') return { cls: 'ok', icon: 'i-check', text: 'Uploaded ' + fmtTime(it.uploadedAt) };
    if (it.status === 'stamping') return { cls: 'active', icon: 'i-cloud', text: 'Adding stamp…' };
    if (it.status === 'failed') return { cls: 'err', icon: 'i-alert', text: 'Could not add the stamp' };
    if (it.id === state.uploadingId) return { cls: 'active', icon: 'i-cloud', text: 'Uploading…' };
    if (state.pinError) return { cls: 'err', icon: 'i-alert', text: 'Rejected: PIN not active' };
    return { cls: 'wait', icon: 'i-cloud', text: navigator.onLine === false ? 'Waiting for signal' : 'Waiting to upload' };
  }

  const thumbKey = it => it.id + (it.thumb ? ':t' : ':r'); // new URL once the stamped thumbnail exists
  function thumbUrl(it) {
    const k = thumbKey(it);
    if (!thumbUrls.has(k)) {
      const b = it.thumb || (it.kind === 'video' ? null : it.blob || it.raw);
      thumbUrls.set(k, b ? URL.createObjectURL(b) : '');
    }
    return thumbUrls.get(k);
  }

  function setStatus(el, st) {
    el.className = 'recent-status ' + st.cls;
    el.innerHTML = `<svg class="ic"><use href="#${st.icon}"/></svg><span></span>`;
    el.lastChild.textContent = st.text;
  }

  function renderRecent(items) {
    items = items.slice().sort((a, b) => b.created - a.created);
    const live = new Set(items.map(thumbKey));
    for (const [id, u] of thumbUrls) if (!live.has(id)) { if (u) URL.revokeObjectURL(u); thumbUrls.delete(id); }
    $('recent-count').textContent = items.length ? `· ${items.length}` : '';
    const list = $('recent-list');
    list.textContent = '';
    if (!items.length) {
      list.innerHTML = '<li class="recent-empty">Photos you take show up here for 48 hours.</li>';
      return;
    }
    for (const it of items) {
      const st = statusOf(it);
      const li = document.createElement('li');
      li.innerHTML = '<button class="recent-item' + (it.kind === 'video' ? ' is-video' : '') + '" type="button"><img alt=""><span class="recent-text">'
        + '<span class="recent-when"></span><span class="recent-status"></span></span></button>';
      li.querySelector('img').src = thumbUrl(it);
      li.querySelector('.recent-when').textContent = fmtWhen(takenAt(it));
      setStatus(li.querySelector('.recent-status'), st);
      li.querySelector('button').setAttribute('aria-label', `Photo ${fmtWhen(takenAt(it))}, ${st.text}`);
      li.querySelector('button').onclick = () => openPhoto(it, st);
      list.appendChild(li);
    }
  }

  function openPhoto(it, st) {
    $('photo-img').src = thumbUrl(it);
    $('photo-when').textContent = fmtWhen(takenAt(it));
    setStatus($('photo-status'), st);
    $('photo-dest').textContent = `Photos › ${it.folder}`;
    UI.modal('photo', true);
  }

  // ---------- screens

  function goHome() {
    tickClock();
    if (!state.clockTimer) state.clockTimer = setInterval(tickClock, 1000);
    show('home');
    startGeo();
    initCompass();
    syncTime();
    resumeStamping();
    processQueue();
    refreshBanner();
  }

  function init() {
    const refreshMode = () => {
      $('testmode').hidden = !!flowUrl();
      $('set-version').textContent = 'Version ' + (CFG.VERSION || '') + (flowUrl() ? ' · connected to SharePoint' : ' · not connected');
    };
    refreshMode();
    for (const el of document.querySelectorAll('.app-credit')) {
      el.textContent = `Developed by ${CFG.AUTHOR || 'Kianoush Haratiannejadi'} · v${CFG.VERSION || ''}`;
    }

    const s = settings();
    if (!s.pin || !s.name) show('setup'); else goHome();

    refreshAccess().then(() => {
      refreshMode();
      refreshBanner();
      tickClock();
      if (state.revoked) {
        $('setup-err').textContent = 'Your PIN is no longer active. Ask Kianoush for a new one.';
        show('setup');
      }
    });

    $('setup-save').onclick = async () => {
      const pin = $('setup-code').value.trim();
      const fail = msg => { $('setup-err').textContent = msg; UI.shake($('setup-form')); };
      if (!pin) { fail('Please enter your PIN.'); return; }
      requestCompass(); // needs the tap, so before any await
      $('setup-err').textContent = '';
      busy('Checking PIN…');
      const res = await signIn(pin);
      busy(null);
      if (res === 'offline') { fail('No internet. Connect once to check your PIN, then try again.'); return; }
      if (res !== 'ok') { fail('PIN not recognised. Check it and try again.'); return; }
      state.revoked = false;
      $('setup-code').value = '';
      refreshMode();
      goHome();
      toast('Welcome, ' + settings().name.split(' ')[0]);
    };

    $('compass-enable').onclick = requestCompass;

    $('shutter').onclick = () => {
      state.shotHeading = state.heading !== null && Date.now() - state.headingAt < 5000 ? state.heading : null;
      const input = $('camera-input');
      input.value = '';
      input.click();
    };
    $('camera-input').onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) openPreview(f);
    };

    $('video-btn').onclick = () => {
      state.shotHeading = state.heading !== null && Date.now() - state.headingAt < 5000 ? state.heading : null;
      const input = $('video-input');
      input.value = '';
      input.click();
    };
    $('video-input').onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) openVideo(f);
    };

    $('retake').onclick = () => {
      const again = state.current && state.current.kind === 'video' ? 'video-btn' : 'shutter';
      clearPreview(); $(again).click();
    };

    // Approve saves the photo on the phone first; stamping and uploading continue in the background.
    $('approve').onclick = async () => {
      const c = state.current;
      if (!c) return;
      const item = c.item;
      if (c.result) Object.assign(item, c.result, { status: 'pending', raw: null });
      if (c.thumbJob) item.thumb = await Promise.race([c.thumbJob, new Promise(r => setTimeout(() => r(null), 1500))]);
      try {
        await DB.put(item);
      } catch (e) {
        toast('Could not save the photo. Please try again.', { ms: 4000, error: true });
        return;
      }
      clearPreview(); show('home');
      toast('Saved. Uploading in the background', { icon: 'i-cloud' });
      refreshBanner();
      if (c.result) processQueue();
      else finishStamp(item, c.job);
    };

    $('save-copy').onclick = () => {
      const c = state.current;
      if (c && c.result) saveToPhone({ blob: c.result.blob, filename: c.item.filename });
    };

    $('open-settings').onclick = () => {
      $('set-name').textContent = settings().name;
      $('set-code').value = '';
      refreshBanner();
      show('settings');
    };
    $('close-settings').onclick = () => show('home');
    $('set-save').onclick = async () => {
      const code = $('set-code').value.trim();
      if (!code) { toast('Enter the new PIN first', { error: true }); return; }
      const res = await signIn(code);
      if (res === 'offline') { toast('No internet. Try again with signal', { ms: 3500, error: true }); return; }
      if (res !== 'ok') { toast('PIN not recognised', { ms: 3500, error: true }); return; }
      $('set-name').textContent = settings().name;
      $('set-code').value = '';
      state.pinError = false;
      refreshMode();
      toast('Saved');
      processQueue();
    };
    $('set-retry').onclick = () => { state.pinError = false; processQueue(); };

    const closePhoto = () => UI.modal('photo', false);
    $('photo-close').onclick = closePhoto;
    $('photo').onclick = e => { if (e.target === $('photo')) closePhoto(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePhoto(); });

    window.addEventListener('online', processQueue);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { processQueue(); syncTime(); }
    });
    setInterval(processQueue, 30000);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  init();
})();
