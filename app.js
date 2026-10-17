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

  // The upload URL lives in pins.txt, encrypted once per team code (one line per code,
  // made with admin.html). A code that decrypts a line is valid; the flow checks the same code.
  // Deleting a line from pins.txt revokes that code on every phone.
  const flowUrl = () => store.get('flow') || (CFG.FLOW_URL || '').trim();

  const b64bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // Resolves to { salt, iter, entries:[{iv,data}] } or null when offline / missing.
  async function loadPins() {
    try {
      const r = await fetch('pins.txt?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      const out = { salt: '', iter: 0, entries: [] };
      for (const raw of (await r.text()).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const head = /^salt=(\S+)\s+iter=(\d+)/.exec(line);
        if (head) { out.salt = head[1]; out.iter = +head[2]; continue; }
        const m = /^([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)/.exec(line);
        if (m) out.entries.push({ iv: m[1], data: m[2] });
      }
      return out.salt && out.iter ? out : null;
    } catch (e) {
      return null;
    }
  }

  // Resolves to the flow URL, null if the code matches no line, or undefined if pins.txt is unreachable.
  async function unlockFlow(code) {
    if (!code || !(window.crypto && crypto.subtle)) return null;
    const pins = await loadPins();
    if (!pins) return undefined;
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64bytes(pins.salt), iterations: pins.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    for (const e of pins.entries) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64bytes(e.iv) }, key, b64bytes(e.data));
        const url = new TextDecoder().decode(plain);
        if (/^https:\/\//.test(url)) return url;
      } catch (err) { /* not this line */ }
    }
    return null;
  }

  // Resolves to 'ok', 'wrong' or 'offline'.
  async function connect(code) {
    const url = await unlockFlow(code);
    if (url === undefined) return 'offline';
    if (!url) return 'wrong';
    store.set('flow', url); store.set('pin', code);
    return 'ok';
  }

  // On launch: re-check the saved code against the latest pins.txt (picks up a new URL,
  // and disconnects the phone if its code was removed). Offline: keep what we have.
  async function refreshFlow() {
    const s = settings();
    if (!s.pin) return;
    if ((await connect(s.pin)) === 'wrong') {
      store.set('flow', ''); store.set('pin', '');
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

  function makeItem(blob, taken, pos, address) {
    const s = settings();
    const folder = `${taken.getFullYear()}-${pad(taken.getMonth() + 1)}-${pad(taken.getDate())}`;
    const who = (s.name || 'user').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `${folder}_${pad(taken.getHours())}${pad(taken.getMinutes())}${pad(taken.getSeconds())}_${who}_${rand}.jpg`;
    const meta = { user: s.name, takenAt: taken.toISOString(), address: address.join(', ') };
    if (pos) {
      meta.latitude = pos.coords.latitude;
      meta.longitude = pos.coords.longitude;
      meta.accuracy = Math.round(pos.coords.accuracy);
    }
    if (typeof state.shotHeading === 'number') meta.heading = Math.round(state.shotHeading);
    return { id: Date.now() + '-' + rand, created: Date.now(), folder, filename, blob, meta };
  }

  async function processPhoto(file) {
    busy('Stamping photo…');
    let img = null;
    try {
      const taken = new Date(file.lastModified && Math.abs(Date.now() - file.lastModified) < 600000 ? file.lastModified : Date.now());
      const pos = await freshPosition();
      const lat = pos ? pos.coords.latitude : undefined;
      const lon = pos ? pos.coords.longitude : undefined;
      const [image, address, map] = await Promise.all([
        loadImage(file),
        pos ? addressFor(lat, lon) : Promise.resolve([]),
        pos ? Stamp.loadMap(lat, lon, ZOOM).catch(() => null) : Promise.resolve(null),
      ]);
      img = image;
      let network = null;
      if (state.timeOffset !== null && Math.abs(state.timeOffset) >= 2000) network = new Date(taken.getTime() + state.timeOffset);
      else if (state.timeOffset !== null) network = taken;

      const canvas = Stamp.render(img, {
        taken, network, lat, lon, heading: state.shotHeading, address, map, user: settings().name,
      });
      const blob = await new Promise((res, rej) => canvas.toBlob(
        b => b ? res(b) : rej(new Error('Could not create image')), 'image/jpeg', CFG.JPEG_QUALITY || 0.9));
      canvas.width = canvas.height = 0; // release memory on iOS

      const item = makeItem(blob, taken, pos, address);
      const url = URL.createObjectURL(blob);
      state.current = { blob, url, item };
      $('preview-img').src = url;
      $('preview-dest').textContent = `Photos › ${item.folder}`;
      show('preview');
    } catch (err) {
      toast('Could not process photo: ' + err.message, { ms: 4000, error: true });
    } finally {
      if (img) URL.revokeObjectURL(img.src);
      busy(null);
    }
  }

  function clearPreview() {
    if (state.current) URL.revokeObjectURL(state.current.url);
    state.current = null;
    $('preview-img').removeAttribute('src');
  }

  // Opens the iOS share sheet ("Save Image") or downloads as a fallback. Must run inside a tap.
  function saveToPhone(item) {
    const file = new File([item.blob], item.filename, { type: 'image/jpeg' });
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
      }, 180000);
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
      const items = (await DB.all()).sort((a, b) => a.created - b.created);
      for (let i = 0; i < items.length; i++) {
        if (navigator.onLine === false) break;
        state.uploadProgress = `Uploading ${i + 1} of ${items.length}…`;
        refreshBanner();
        const res = await upload(items[i]);
        if (res === 'ok') {
          await DB.del(items[i].id);
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
      state.uploadProgress = '';
      refreshBanner();
    }
  }

  async function refreshBanner() {
    let n = 0;
    try { n = (await DB.all()).length; } catch (e) { /* ignore */ }
    const plural = `${n} photo${n > 1 ? 's' : ''}`;
    let msg, kind, icon;
    if (state.pinError && n) { msg = `Upload rejected. Enter the new team code in Settings (${plural} waiting)`; kind = 'error'; icon = 'i-alert'; }
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

  // ---------- screens

  function goHome() {
    tickClock();
    if (!state.clockTimer) state.clockTimer = setInterval(tickClock, 1000);
    show('home');
    startGeo();
    initCompass();
    syncTime();
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
    if (!s.name || !flowUrl()) show('setup'); else goHome();

    refreshFlow().then(() => {
      refreshMode();
      refreshBanner();
      if (state.revoked) {
        $('setup-name').value = settings().name;
        $('setup-err').textContent = 'Your team code is no longer valid. Ask Kianoush for a new one.';
        show('setup');
      }
    });

    $('setup-save').onclick = async () => {
      const name = $('setup-name').value.trim();
      const code = $('setup-code').value.trim();
      const fail = msg => { $('setup-err').textContent = msg; UI.shake($('setup-form')); };
      if (!name) { fail('Please enter your name.'); return; }
      if (!code) { fail('Please enter the team code.'); return; }
      requestCompass(); // needs the tap, so before any await
      $('setup-err').textContent = '';
      busy('Checking code…');
      const res = await connect(code);
      busy(null);
      if (res === 'offline') { fail('No internet. Connect once to check your code, then try again.'); return; }
      if (res !== 'ok') { fail('Wrong team code. Check it and try again.'); return; }
      state.revoked = false;
      store.set('name', name);
      refreshMode();
      goHome();
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
      if (f) processPhoto(f);
    };

    $('retake').onclick = () => { clearPreview(); $('shutter').click(); };

    $('approve').onclick = async () => {
      const c = state.current;
      if (!c) return;
      if (!flowUrl()) {
        await saveToPhone(c.item);
        clearPreview(); show('home');
        return;
      }
      try {
        await DB.put(c.item);
      } catch (e) {
        toast('Could not save photo for upload. Use "Save a copy" instead.', { ms: 4000, error: true });
        return;
      }
      clearPreview(); show('home');
      toast('Saved. Uploading…', { icon: 'i-cloud' });
      refreshBanner();
      processQueue();
    };

    $('save-copy').onclick = () => { if (state.current) saveToPhone(state.current.item); };

    $('open-settings').onclick = () => {
      const s2 = settings();
      $('set-name').value = s2.name; $('set-code').value = '';
      refreshBanner();
      show('settings');
    };
    $('close-settings').onclick = () => show('home');
    $('set-save').onclick = async () => {
      const name = $('set-name').value.trim();
      if (!name) { toast('Name cannot be empty', { error: true }); return; }
      const code = $('set-code').value.trim();
      if (code) {
        const res = await connect(code);
        if (res === 'offline') { toast('No internet. Try again with signal', { ms: 3500, error: true }); return; }
        if (res !== 'ok') { toast('Wrong team code', { ms: 3500, error: true }); return; }
      }
      store.set('name', name);
      $('set-code').value = '';
      state.pinError = false;
      refreshMode();
      toast('Saved');
      processQueue();
    };
    $('set-retry').onclick = () => { state.pinError = false; processQueue(); };

    window.addEventListener('online', processQueue);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { processQueue(); syncTime(); }
    });
    setInterval(processQueue, 30000);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  init();
})();
