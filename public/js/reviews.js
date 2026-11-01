// Customer reviews on the shop page: average stars, approved reviews shown in a rolling
// carousel (1 card on phones, up to 3 on desktop, auto-advances every 5 s), "Leave a review" form.
// Everything shoppers typed is put in the page with textContent (never as HTML).
(function () {
  'use strict';

  // ---- carousel maths (pure, no DOM; also loaded by test/reviews-carousel.test.js) ----
  const Carousel = {
    INTERVAL_MS: 5000,
    /** Cards visible at once for a carousel this many px wide, never more than there are reviews. */
    perView(width, count) {
      const per = width < 640 ? 1 : width < 980 ? 2 : 3;
      return Math.max(1, Math.min(per, count || 1));
    },
    /** Last valid start position (cards i … i+per-1 are on screen). */
    lastIndex(count, per) { return Math.max(0, count - per); },
    /** Move one step; past either end it loops round ("wrapped" = jump, not slide). */
    step(index, dir, count, per) {
      const last = Carousel.lastIndex(count, per);
      const next = index + (dir < 0 ? -1 : 1);
      if (next > last) return { index: 0, wrapped: true };
      if (next < 0) return { index: last, wrapped: true };
      return { index: next, wrapped: false };
    },
    /** Rotates only when there is something off-screen and nothing asks it to hold still. */
    shouldRotate({ count, per, reducedMotion, paused, hidden }) {
      return count > per && !reducedMotion && !paused && !hidden;
    },
    /** Featured reviews first, then newest (the server already sends them this way). */
    order(reviews) {
      return (reviews || []).map((r, i) => [r, i])
        .sort((a, b) => (Number(!!b[0].featured) - Number(!!a[0].featured)) || a[1] - b[1])
        .map((p) => p[0]);
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Carousel;
  if (typeof document === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const section = $('reviews');
  if (!section) return;
  const WORDS = { 1: 'Bad', 2: 'Poor', 3: 'Good', 4: 'Great', 5: 'Amazing' };

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  /** Set a .stars element to n out of 5 (partial fill for averages such as 4.6). */
  function setStars(s, n) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', `${n} out of 5 stars`);
    s.style.setProperty('--fill', Math.max(0, Math.min(100, (Number(n) / 5) * 100)) + '%');
    return s;
  }
  const stars = (n, cls) => setStars(el('span', 'stars' + (cls ? ' ' + cls : '')), n);
  const ukDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

  function render(d) {
    const pill = $('rating-pill');
    section.hidden = !d.enabled;
    if (!d.enabled) { if (pill) pill.hidden = true; return; }
    const has = d.count > 0;
    $('reviews-avg').textContent = has ? d.average.toFixed(1) : '–';
    setStars($('reviews-avg-stars'), has ? d.average : 0);
    $('reviews-count').textContent = has ? `${d.count} review${d.count === 1 ? '' : 's'}` : 'No reviews yet — be the first!';
    const bars = $('reviews-bars');
    bars.textContent = '';
    bars.hidden = !has;
    if (has) {
      for (let i = 5; i >= 1; i--) {
        const n = d.breakdown[i] || 0;
        const row = el('div', 'bar-row');
        row.append(el('span', 'bar-k', `${i}★`));
        const track = el('span', 'bar-track'); const fill = el('span', 'bar-fill');
        fill.style.width = `${Math.round((n / d.count) * 100)}%`;
        track.append(fill); row.append(track, el('span', 'bar-n', String(n)));
        bars.append(row);
      }
    }
    if (pill) {
      pill.hidden = !has;
      if (has) {
        setStars(pill.querySelector('[data-stars]'), d.average);
        pill.querySelector('[data-avg]').textContent = d.average.toFixed(1);
        pill.querySelector('[data-count]').textContent = `· ${d.count} review${d.count === 1 ? '' : 's'}`;
      }
    }
    const list = $('review-list');
    if (carousel) { carousel.destroy(); carousel = null; }
    list.textContent = '';
    if (!has) {
      const empty = el('div', 'review-empty');
      empty.append(el('div', 'empty-ball'), el('p', null, 'No reviews yet. Bought from us? Tell other trainers how it went!'));
      list.append(empty);
      return;
    }
    carousel = buildCarousel(list, Carousel.order(d.reviews).map(reviewCard));
  }

  function reviewCard(r) {
    const card = el('article', 'review-card' + (r.featured ? ' featured' : ''));
    const top = el('div', 'review-top');
    top.append(stars(r.rating));
    if (r.featured) top.append(el('span', 'review-badge featured', '★ Featured'));
    if (r.verified) top.append(el('span', 'review-badge verified', '✔ Verified purchase'));
    const body = el('p', 'review-comment', r.comment);
    const foot = el('div', 'review-foot');
    foot.append(el('strong', 'review-name', r.name), el('time', 'hint', ukDate(r.createdAt)));
    foot.lastChild.dateTime = r.createdAt;
    card.append(top, body, foot);
    return card;
  }

  // ---- rolling carousel ----
  let carousel = null;
  const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function buildCarousel(host, cards) {
    const n = cards.length;
    const root = el('div', 'review-carousel');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-roledescription', 'carousel');
    root.setAttribute('aria-label', 'Customer reviews');
    root.tabIndex = -1;
    const prev = el('button', 'rc-arrow rc-prev', '‹');
    prev.type = 'button'; prev.setAttribute('aria-label', 'Previous review');
    const next = el('button', 'rc-arrow rc-next', '›');
    next.type = 'button'; next.setAttribute('aria-label', 'Next review');
    const viewport = el('div', 'rc-viewport');
    const track = el('div', 'rc-track');
    track.setAttribute('aria-live', 'off');
    const slides = cards.map((card, i) => {
      const s = el('div', 'rc-slide');
      s.setAttribute('role', 'group');
      s.setAttribute('aria-roledescription', 'slide');
      s.setAttribute('aria-label', `${i + 1} of ${n}`);
      s.append(card);
      track.append(s);
      return s;
    });
    viewport.append(track);
    const dots = el('div', 'rc-dots');
    dots.setAttribute('role', 'group');
    dots.setAttribute('aria-label', 'Choose reviews to show');
    root.append(prev, viewport, next, dots);
    host.append(root);

    let index = 0;
    let per = 1;
    let timer = null;
    let hover = false;
    let focus = false;
    const reduced = () => !!(reducedMotionQuery && reducedMotionQuery.matches);

    function paint(opts = {}) {
      root.style.setProperty('--per', per);
      root.style.setProperty('--i', index);
      root.classList.toggle('single', n === 1);
      root.classList.toggle('static', n <= per);
      prev.hidden = next.hidden = dots.hidden = n <= per;
      if (opts.jump) {
        track.classList.add('no-anim');
        void track.offsetWidth; // apply the jump without the slide transition
        track.classList.remove('no-anim');
      }
      slides.forEach((s, i) => {
        const on = i >= index && i < index + per;
        const was = s.classList.contains('is-on');
        s.classList.toggle('is-on', on);
        s.setAttribute('aria-hidden', String(!on));
        s.inert = !on;
        if (on && (!was || opts.jump) && opts.animate && !reduced()) {
          s.classList.remove('pop'); void s.offsetWidth; s.classList.add('pop');
        }
      });
      const last = Carousel.lastIndex(n, per);
      if (dots.childElementCount !== last + 1) {
        dots.textContent = '';
        for (let i = 0; i <= last; i++) {
          const b = el('button', 'rc-dot');
          b.type = 'button';
          b.setAttribute('aria-label', per === 1 ? `Show review ${i + 1}` : `Show reviews ${i + 1} to ${i + per}`);
          b.addEventListener('click', () => go(i, true));
          dots.append(b);
        }
      }
      [...dots.children].forEach((b, i) => b.setAttribute('aria-current', String(i === index)));
    }

    function go(i, byUser) {
      const last = Carousel.lastIndex(n, per);
      const target = Math.max(0, Math.min(last, i));
      const jump = Math.abs(target - index) > 1 && !byUser;
      index = target;
      track.setAttribute('aria-live', byUser ? 'polite' : 'off');
      paint({ animate: true, jump });
      schedule();
    }
    function move(dir, byUser) {
      const r = Carousel.step(index, dir, n, per);
      index = r.index;
      track.setAttribute('aria-live', byUser ? 'polite' : 'off');
      paint({ animate: true, jump: r.wrapped });
      schedule();
    }

    function schedule() {
      clearTimeout(timer); timer = null;
      root.classList.toggle('paused', hover || focus);
      if (!Carousel.shouldRotate({ count: n, per, reducedMotion: reduced(), paused: hover || focus, hidden: document.hidden })) return;
      timer = setTimeout(() => move(1, false), Carousel.INTERVAL_MS);
    }

    function measure() {
      const p = Carousel.perView(viewport.clientWidth || host.clientWidth || window.innerWidth, n);
      if (p !== per) { per = p; index = Math.min(index, Carousel.lastIndex(n, per)); paint({ jump: true }); }
      schedule();
    }

    prev.addEventListener('click', () => move(-1, true));
    next.addEventListener('click', () => move(1, true));
    root.addEventListener('keydown', (e) => {
      if (n <= per || e.target.closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1, true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1, true); }
    });
    root.addEventListener('mouseenter', () => { hover = true; schedule(); });
    root.addEventListener('mouseleave', () => { hover = false; schedule(); });
    root.addEventListener('focusin', () => { focus = true; schedule(); });
    root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) { focus = false; schedule(); } });

    // swipe on phones / tablets
    let sx = null; let sy = 0;
    viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { sx = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      clearTimeout(timer);
    }, { passive: true });
    viewport.addEventListener('touchend', (e) => {
      if (sx == null) return schedule();
      const t = e.changedTouches[0];
      const dx = t.clientX - sx; const dy = t.clientY - sy;
      sx = null;
      if (n > per && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1, true); else schedule();
    }, { passive: true });
    viewport.addEventListener('touchcancel', () => { sx = null; schedule(); }, { passive: true });

    let rz = null;
    const onResize = () => { clearTimeout(rz); rz = setTimeout(measure, 120); };
    const onVisibility = () => schedule();
    const onMotion = () => schedule();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    if (reducedMotionQuery && reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', onMotion);

    per = Carousel.perView(viewport.clientWidth || host.clientWidth || window.innerWidth, n);
    paint({ jump: true });
    schedule();

    return {
      destroy() {
        clearTimeout(timer); clearTimeout(rz);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        if (reducedMotionQuery && reducedMotionQuery.removeEventListener) reducedMotionQuery.removeEventListener('change', onMotion);
        root.remove();
      },
    };
  }

  async function load() {
    try {
      const r = await fetch('/api/reviews', { credentials: 'same-origin' });
      if (!r.ok) throw new Error();
      render(await r.json());
    } catch { section.hidden = true; }
  }

  // ---- form ----
  const form = $('review-form');
  const openBtn = $('review-open');
  function showForm(on) {
    form.hidden = !on;
    openBtn.setAttribute('aria-expanded', String(on));
    openBtn.hidden = on;
    if (on) { form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setTimeout(() => $('star5').focus({ preventScroll: true }), 50); }
  }
  openBtn.addEventListener('click', () => showForm(true));
  $('rv-cancel').addEventListener('click', () => { showForm(false); $('review-msg').textContent = ''; });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'rating') $('star-word').textContent = `${e.target.value} star${e.target.value === '1' ? '' : 's'} — ${WORDS[e.target.value]}`;
  });
  $('rv-comment').addEventListener('input', (e) => { $('rv-chars').textContent = e.target.value.length; });

  function fieldError(field, text) {
    form.querySelectorAll('[data-err]').forEach((s) => { s.textContent = s.dataset.err === field ? text : ''; });
    form.querySelectorAll('.invalid').forEach((i) => i.classList.remove('invalid'));
    const input = field && form.querySelector(`[name="${field}"]:not([type=radio])`);
    if (input) { input.classList.add('invalid'); input.focus(); }
    if (field === 'rating') $('star5').focus();
  }

  function check(body) {
    if (!body.rating) return ['rating', 'Please choose 1 to 5 stars'];
    if (!body.name.trim()) return ['name', 'Please enter your name (first name is fine)'];
    if (body.comment.trim().length < 10) return ['comment', 'Please write at least 10 characters'];
    if (body.order && !/^#?[A-Za-z0-9_-]+$/.test(body.order.trim())) return ['order', 'Order number can only contain letters, numbers, - and _'];
    return null;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { rating: Number(fd.get('rating')) || 0, name: fd.get('name') || '', comment: fd.get('comment') || '', order: fd.get('order') || '', website: fd.get('website') || '' };
    const bad = check(body);
    const msg = $('review-msg');
    msg.className = 'review-msg';
    if (bad) { fieldError(bad[0], bad[1]); return; }
    fieldError(null, '');
    $('rv-submit').disabled = true;
    try {
      const r = await fetch('/api/reviews', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d.field) fieldError(d.field, d.error); else { msg.classList.add('err'); msg.textContent = d.error || 'Could not send your review'; }
        if (r.status === 403) load();
        return;
      }
      form.reset();
      $('rv-chars').textContent = '0';
      $('star-word').textContent = '';
      form.hidden = true;
      openBtn.hidden = false;
      openBtn.setAttribute('aria-expanded', 'false');
      const thanks = $('review-thanks') || el('p', 'review-msg ok');
      thanks.id = 'review-thanks';
      thanks.textContent = 'Thank you! Your review has been sent and will appear once we have checked it.';
      form.after(thanks);
    } catch {
      msg.classList.add('err');
      msg.textContent = 'Could not send your review — please check your connection and try again';
    } finally {
      $('rv-submit').disabled = false;
    }
  });

  load();
})();
