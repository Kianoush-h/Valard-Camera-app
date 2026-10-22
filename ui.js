// Valard Camera UI motion (GSAP). Everything degrades to instant changes when GSAP is
// missing or the user prefers reduced motion. Exposes window.UI.
(function () {
  'use strict';

  const G = window.gsap;
  const $ = id => document.getElementById(id);
  let reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = () => !!G && !reduce;

  if (G) {
    gsap.defaults({ ease: 'power3.out', duration: 0.3 });
    gsap.matchMedia().add('(prefers-reduced-motion: reduce)', () => {
      reduce = true;
      return () => { reduce = false; };
    });
  }

  // Screen depth: moving to a deeper screen slides left, going back slides right.
  const DEPTH = { setup: 0, home: 1, settings: 2, preview: 2 };
  let current = null;

  function enterContents(screen) {
    const items = screen.querySelectorAll('[data-enter]');
    if (!items.length) return;
    gsap.fromTo(items, { y: 18, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.42, stagger: 0.05, clearProps: 'transform,opacity,visibility' });
  }

  function go(id) {
    const next = $(id);
    const prev = current && current !== id ? $(current) : null;
    if (current === id) return;
    for (const s of document.querySelectorAll('.screen')) if (s !== next && s !== prev) s.hidden = true;
    next.hidden = false;
    next.scrollTop = 0;

    if (!animate()) {
      if (prev) prev.hidden = true;
      current = id;
      return;
    }

    const forward = (DEPTH[id] ?? 1) >= (DEPTH[current] ?? 0);
    gsap.killTweensOf([next, prev]);
    if (prev) {
      gsap.to(prev, {
        xPercent: forward ? -8 : 8, autoAlpha: 0, duration: 0.2, ease: 'power2.in',
        onComplete: () => { prev.hidden = true; gsap.set(prev, { clearProps: 'all' }); },
      });
    }

    if (id === 'preview') {
      gsap.fromTo(next, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, clearProps: 'opacity,visibility' });
      gsap.fromTo('#preview-img', { scale: 0.94, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.45, delay: 0.05, clearProps: 'all' });
      gsap.fromTo('#preview-sheet', { yPercent: 100 }, { yPercent: 0, duration: 0.45, delay: 0.1, ease: 'expo.out', clearProps: 'transform' });
    } else {
      gsap.fromTo(next, { xPercent: prev ? (forward ? 8 : -8) : 0, autoAlpha: 0 },
        { xPercent: 0, autoAlpha: 1, duration: 0.32, delay: prev ? 0.06 : 0, clearProps: 'transform,opacity,visibility' });
      enterContents(next);
    }
    current = id;
  }

  // ---------- toast

  let toastTimer = null;
  function toast(msg, opts) {
    const o = typeof opts === 'number' ? { ms: opts } : (opts || {});
    const t = $('toast');
    const icon = o.error ? 'i-alert' : (o.icon || 'i-check');
    t.className = 'toast' + (o.error ? ' err' : '');
    t.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span></span>`;
    t.lastChild.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (animate()) {
      gsap.killTweensOf(t);
      gsap.fromTo(t, { y: -30, autoAlpha: 0, scale: 0.96 }, { y: 0, autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(1.6)' });
    }
    toastTimer = setTimeout(() => {
      if (animate()) gsap.to(t, { y: -20, autoAlpha: 0, duration: 0.2, ease: 'power2.in', onComplete: () => { t.hidden = true; } });
      else t.hidden = true;
    }, o.ms || 2800);
  }

  // ---------- busy overlay

  function busy(msg) {
    const b = $('busy');
    if (msg) {
      $('busy-text').textContent = msg;
      if (!b.hidden) return;
      b.hidden = false;
      if (animate()) {
        gsap.fromTo(b, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
        gsap.fromTo(b.firstElementChild, { scale: 0.9 }, { scale: 1, duration: 0.35, ease: 'back.out(1.8)' });
      }
    } else if (!b.hidden) {
      if (animate()) gsap.to(b, { autoAlpha: 0, duration: 0.15, onComplete: () => { b.hidden = true; gsap.set(b, { clearProps: 'all' }); } });
      else b.hidden = true;
    }
  }

  // ---------- popup (photo viewer)

  function modal(id, open) {
    const m = $(id);
    if (open) {
      m.hidden = false;
      if (animate()) {
        gsap.killTweensOf(m);
        gsap.fromTo(m, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 });
        gsap.fromTo(m.firstElementChild, { y: 40, scale: 0.96 }, { y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.4)', clearProps: 'transform' });
      }
    } else if (!m.hidden) {
      if (animate()) gsap.to(m, { autoAlpha: 0, duration: 0.15, onComplete: () => { m.hidden = true; gsap.set(m, { clearProps: 'all' }); } });
      else m.hidden = true;
    }
  }

  // ---------- compass dial (rotates so the red tip points to real north)

  let dialAngle = 0;
  function setHeading(h) {
    const rose = $('dial-rose');
    if (!rose) return;
    // shortest path so 359° -> 1° doesn't spin the whole way round
    let target = -h;
    const delta = ((target - dialAngle) % 360 + 540) % 360 - 180;
    dialAngle += delta;
    if (animate()) gsap.to(rose, { rotation: dialAngle, svgOrigin: '20 20', duration: 0.4, ease: 'power2.out', overwrite: true });
    else rose.setAttribute('transform', `rotate(${dialAngle} 20 20)`);
  }

  // ---------- small feedback effects

  function shake(el) {
    if (!animate() || !el) return;
    gsap.fromTo(el, { x: -10 }, { x: 0, duration: 0.6, ease: 'elastic.out(1, 0.3)', clearProps: 'transform' });
  }

  function pop(el) {
    if (!animate() || !el) return;
    gsap.fromTo(el, { scale: 0.5 }, { scale: 1, duration: 0.5, ease: 'back.out(2.2)', clearProps: 'transform' });
  }

  function updateText(el, text) {
    if (!el || el.textContent === text) return;
    el.textContent = text;
    if (animate()) gsap.fromTo(el, { autoAlpha: 0.3 }, { autoAlpha: 1, duration: 0.3, clearProps: 'opacity,visibility' });
  }

  // Shutter: press feedback + a slow "ready" halo so the main action is obvious.
  function initShutter() {
    const btn = $('shutter');
    if (!btn || !animate()) return;
    const core = btn.querySelector('.shutter-core');
    const halo = btn.querySelector('.shutter-halo');
    gsap.fromTo(halo, { scale: 0.85, autoAlpha: 0.8 }, { scale: 1.15, autoAlpha: 0, duration: 2, ease: 'sine.out', repeat: -1, repeatDelay: 0.6 });
    const down = () => gsap.to(core, { scale: 0.88, duration: 0.12, ease: 'power2.out', overwrite: true });
    const up = () => gsap.to(core, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.4)', overwrite: true });
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  }

  // Show/hide toggles for code fields.
  function initReveal() {
    for (const b of document.querySelectorAll('[data-reveal]')) {
      b.addEventListener('click', () => {
        const input = $(b.dataset.reveal);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.setAttribute('aria-pressed', String(show));
        b.setAttribute('aria-label', show ? 'Hide code' : 'Show code');
      });
    }
  }

  const init = () => { initShutter(); initReveal(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.UI = { go, toast, busy, modal, setHeading, shake, pop, updateText };
})();
