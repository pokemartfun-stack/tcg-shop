'use strict';
// Turns an uploaded JSON file (shop schema OR the Vinted Listing Tool export) into
// shop products, with per-item errors instead of failing the whole file.
const store = require('./products-store');
const { stem, baseName } = require('./images');

const { normaliseCategory } = require('../public/js/categories');

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '') || 'card';
}

function parsePrice(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const cleaned = String(v).replace(/[£$€,\s]|GBP/gi, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

/**
 * Vinted "Hobbies & Collectables > Trading cards" -> "Trading cards"; sealed / accessory words
 * ("Booster box", "Card sleeves" ...) -> "Sealed products" / "Accessories"; anything else ->
 * "Trading cards" (so it shows in the Cards & Lots tab).
 */
function mapCategory(v) {
  return normaliseCategory(v);
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // UK style 05/10/2026 or 05-10-2026 [14:32]
  const uk = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  let d;
  if (uk) d = new Date(+uk[3], +uk[2] - 1, +uk[1], +(uk[4] || 0), +(uk[5] || 0), +(uk[6] || 0));
  else d = new Date(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const isUrl = (u) => /^(https?:\/\/|\/(?![a-z]:))[^\s"'<>\\]*$/i.test(u) && !/^\/(home|users|mnt|var|tmp)\//i.test(u);

function looksVinted(item) {
  return item && typeof item === 'object' &&
    item.price_gbp === undefined &&
    ['price', 'quality', 'photo', 'photos', 'postage_size', 'product_type', 'date_added'].some((k) => k in item);
}

/** Collect photo references from any of image/images/photo/photos. */
function photoRefs(item) {
  const refs = [];
  const push = (v) => { if (v && typeof v === 'string' && v.trim()) refs.push(v.trim()); };
  push(item.image);
  if (Array.isArray(item.images)) item.images.forEach(push);
  push(item.photo);
  if (Array.isArray(item.photos)) item.photos.forEach(push);
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const key = isUrl(r) ? r : `local:${stem(r)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * @returns {{ items: Array<{index, product, localRefs: string[]}>, errors: Array<{index, title, error}>, format }}
 */
function importList(list) {
  if (!Array.isArray(list)) {
    if (list && typeof list === 'object' && Array.isArray(list.products)) list = list.products;
    else if (list && typeof list === 'object' && Array.isArray(list.listings)) list = list.listings;
    else return { items: [], errors: [{ index: null, title: '', error: 'The file must contain a list of cards: [ {...}, {...} ]' }], format: null };
  }
  const items = [];
  const errors = [];
  const usedIds = new Set();
  let vintedCount = 0;
  let shopCount = 0;

  list.forEach((raw, index) => {
    const title = raw && typeof raw === 'object' ? String(raw.title || '').trim() : '';
    const fail = (error) => errors.push({ index, title: title || `(item ${index + 1})`, error });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Not a card object');
    if (!title) return fail('Missing title');

    const vinted = looksVinted(raw);
    if (vinted) vintedCount++; else shopCount++;
    const priceRaw = raw.price_gbp !== undefined ? raw.price_gbp : raw.price;
    const price = parsePrice(priceRaw);
    if (!Number.isFinite(price) || price < 0) return fail(`Price "${priceRaw ?? ''}" is not a valid amount (use e.g. 4.99)`);
    const stockRaw = raw.stock ?? raw.quantity ?? 1;
    const stock = Number(stockRaw);
    if (!Number.isInteger(stock) || stock < 0) return fail(`Stock "${stockRaw}" must be a whole number`);

    // id: explicit, else slug of title (+ -2, -3 … if the same title appears again in this file)
    let id;
    if (raw.id !== undefined && raw.id !== '') {
      id = String(raw.id).trim();
      if (!store.ID_RE.test(id)) return fail(`id "${id}" may only use letters, numbers, - and _`);
      if (usedIds.has(id)) return fail(`Duplicate id "${id}" in this file`);
    } else {
      const base = slugify(title);
      id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    }

    const refs = photoRefs(raw);
    const urls = refs.filter(isUrl);
    const localRefs = refs.filter((r) => !isUrl(r));

    const r = store.normalise({
      id,
      title,
      description: raw.description,
      price_gbp: price,
      condition: raw.condition || raw.quality || 'Near mint',
      category: mapCategory(raw.category || raw.product_type),
      images: urls,
      stock,
      added_at: parseDate(raw.added_at || raw.date_added) || undefined,
      // Vinted Small -> Large Letter, Medium/Large -> Small Parcel; missing -> by category
      postage_band: raw.postage_band,
      postage_size: raw.postage_size || raw.package_size,
    }, index);
    if (r.error) return fail(r.error.replace(/^Item \d+(\s\([^)]*\))?:\s*/, ''));
    if (!urls.length) r.product.images = [];
    usedIds.add(id);
    items.push({ index, product: r.product, localRefs });
  });

  return { items, errors, format: vintedCount && shopCount ? 'mixed' : vintedCount ? 'vinted' : 'shop' };
}

/** Index uploaded files by stem: "IMG_123.HEIC" and "img_123.jpg" both -> "img_123". */
function indexUploads(files) {
  const map = new Map();
  for (const f of files || []) {
    const key = stem(f.originalname);
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

module.exports = { importList, indexUploads, slugify, parsePrice, mapCategory, parseDate, photoRefs, looksVinted, baseName, stem };
