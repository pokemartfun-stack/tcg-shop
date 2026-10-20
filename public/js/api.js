async function api(path, options = {}) {
  const opts = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function formatGbp(n) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

// ---- Page background (admin "Page background"; image lives in the repo at /images/background.jpg) ----
// Cached in localStorage so it paints instantly on the next page, then refreshed from /api/settings.
function applyPageBackground(url) {
  const ok = typeof url === 'string' && /^(https?:\/\/|\/)[^"'()\s\\]*$/i.test(url);
  const root = document.documentElement;
  if (ok) {
    root.style.setProperty('--page-bg-image', `url("${encodeURI(url)}")`);
    root.classList.add('has-page-bg');
  } else {
    root.style.removeProperty('--page-bg-image');
    root.classList.remove('has-page-bg');
  }
}
(function initPageBackground() {
  let cached = null;
  try { cached = localStorage.getItem('pageBg'); } catch { /* private mode */ }
  if (cached !== null) applyPageBackground(cached);
  fetch('/api/settings', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (!s) return;
      const url = s.background_image || '';
      applyPageBackground(url);
      try { localStorage.setItem('pageBg', url); } catch { /* ignore */ }
    })
    .catch(() => {});
})();

window.TCG = { api, formatGbp, applyPageBackground };
