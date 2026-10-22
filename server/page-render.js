'use strict';
// Customer pages are served with the current shop settings already in the HTML:
// banner <img> (src + aspect ratio), page background, logo and shop name. Before, all of
// that was filled in by JavaScript after an extra /api/settings request, so a cold Render
// instance, a slow connection or a failed request left a plain dark page with no banner.
const fs = require('fs');
const path = require('path');
const settingsStore = require('./settings-store');
const images = require('./images');
const { parseTab } = require('../public/js/categories');

let sharp = null;
try { sharp = require('sharp'); } catch { /* ratio is optional */ }

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/cart.html': 'cart.html', '/checkout.html': 'checkout.html', '/success.html': 'success.html' };
const SAFE_URL = /^(https?:\/\/|\/)[^"'()\s\\<>]*$/i;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const okUrl = (u) => typeof u === 'string' && SAFE_URL.test(u);

const templates = new Map();
function template(file) {
  if (!templates.has(file) || process.env.NODE_ENV === 'test') {
    templates.set(file, fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
  }
  return templates.get(file);
}

const ratioCache = new Map(); // url -> { mtime, ratio }
/** "1200 / 300" for our own banner file (first frame of a GIF), else null. */
async function bannerRatio(url) {
  const m = /^\/images\/banner\.(jpg|gif)(\?|$)/.exec(url || '');
  if (!m || !sharp) return null;
  const file = images.bannerFile(m[1]);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = ratioCache.get(url);
  if (hit && hit.mtime === stat.mtimeMs) return hit.ratio;
  try {
    const meta = await sharp(file).metadata();
    const h = meta.pageHeight || meta.height;
    const ratio = meta.width && h ? `${meta.width} / ${h}` : null;
    ratioCache.set(url, { mtime: stat.mtimeMs, ratio });
    return ratio;
  } catch { return null; }
}

/** Pure HTML transform (exported for tests). */
function render(html, s, ratio, opts = {}) {
  let out = html;
  // Shop tabs: mark the tab from ?tab=… as current, so /?tab=sealed paints the right tab first.
  if (out.includes('id="shop-tabs"')) {
    const tab = parseTab(opts.tab);
    out = out.replace(/<a class="shop-tab[^"]*" href="([^"]*)" data-tab="([a-z]+)"(?: aria-current="page")?>/g,
      (_m, href, id) => id === tab
        ? `<a class="shop-tab active" href="${href}" data-tab="${id}" aria-current="page">`
        : `<a class="shop-tab" href="${href}" data-tab="${id}">`);
  }
  // Page background: class + CSS variable on <html>, so the first paint already has it.
  if (okUrl(s.background_image)) {
    out = out.replace('<html lang="en-GB">',
      `<html lang="en-GB" class="has-page-bg" style="--page-bg-image: url(&quot;${esc(encodeURI(s.background_image))}&quot;)">`);
  }
  // Logo + shop name in the nav.
  if (okUrl(s.logo_image)) {
    out = out.replace(/(<img class="brand-logo" src=")[^"]*(")/g, `$1${esc(s.logo_image)}$2`);
  }
  if (s.shop_name) {
    out = out.replace(/(<span class="brand-name" data-shop-name>)[^<]*(<\/span>)/g, `$1${esc(s.shop_name)}$2`);
    out = out.replace(/(<h1 id="hero-name">)[^<]*(<\/h1>)/, `$1${esc(s.shop_name)}$2`);
  }
  out = out.replace(/(<p id="hero-tagline")>[^<]*(<\/p>)/, s.tagline ? `$1>${esc(s.tagline)}$2` : '$1 hidden>$2');
  // Banner: real <img> with src + ratio, so the browser starts downloading it straight away
  // and reserves the right height before it arrives.
  const heroClasses = ['hero-banner'];
  if (okUrl(s.banner_image)) {
    heroClasses.push('has-image');
    out = out.replace('<img class="hero-img" id="hero-img" alt="" hidden />',
      `<img class="hero-img" id="hero-img" alt="" src="${esc(s.banner_image)}" fetchpriority="high"${ratio ? ` style="aspect-ratio: ${ratio}"` : ''} />`);
  }
  if (s.show_banner_text) heroClasses.push('show-text');
  out = out.replace('<section class="hero-banner" id="hero-banner"', `<section class="${heroClasses.join(' ')}" id="hero-banner"`);
  return out;
}

async function handler(req, res, next) {
  const file = PAGES[req.path];
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
  try {
    const s = settingsStore.get();
    const html = render(template(file), s, await bannerRatio(s.banner_image), { tab: req.query && req.query.tab });
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache'); // always revalidate: settings can change any time
    res.end(req.method === 'HEAD' ? undefined : html);
  } catch (err) {
    console.error('Page render failed, serving static file:', err.message);
    next();
  }
}

module.exports = { handler, render, bannerRatio };
