// Customer reviews on the shop page: average stars, approved reviews, "Leave a review" form.
// Everything shoppers typed is put in the page with textContent (never as HTML).
(function () {
  'use strict';
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
    list.textContent = '';
    if (!has) {
      const empty = el('div', 'review-empty');
      empty.append(el('div', 'empty-ball'), el('p', null, 'No reviews yet. Bought from us? Tell other trainers how it went!'));
      list.append(empty);
      return;
    }
    d.reviews.forEach((r) => {
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
      list.append(card);
    });
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
