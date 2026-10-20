'use strict';
// Keeps a card's photos in the order of its JSON export (photo first, then photos[]),
// no matter in which order or batch the files were uploaded.
//
// Each card stores:
//   photo_files: ["img_0001", "img_0002", ...]   lower-case photo names (no extension), JSON order
//   photo_map:   { "img_0001": "/uploads/...jpg" } which uploaded file belongs to which photo name
const path = require('path');
const images = require('./images');

const PLACEHOLDER_RE = /^\/images\/[^/]+\.svg$/i;
const isUpload = (u) => /^\/uploads\//.test(u);

/** Work out which photo name an already-uploaded file belongs to (for cards saved before photo_map existed). */
function inferStem(product, url) {
  const file = path.basename(url).replace(/-[0-9a-f]{10}\.jpg$/, '');
  for (const st of product.photo_files || []) {
    if (file === images.photoBase(product.id, st)) return st; // current naming
    if (file === images.slugPart(`${product.id}-${st}`) && images.slugPart(`${product.id}-${st}`).length < 50) return st; // older naming (only if not truncated)
  }
  return null;
}

/**
 * Returns { product, changed, unresolved } where product.images is sorted:
 *   1. photos named in photo_files, in that order (cover = first)
 *   2. any other photos/URLs, in their current order
 * svg placeholders are dropped once the card has at least one real JSON photo.
 */
function orderImages(product) {
  const before = (product.images && product.images.length ? product.images : [product.image]).filter(Boolean);
  const files = product.photo_files || [];
  const map = { ...(product.photo_map || {}) };
  for (const u of before) {
    if (!isUpload(u) || Object.values(map).includes(u)) continue;
    const st = inferStem(product, u);
    if (st && !(map[st] && before.includes(map[st]))) map[st] = u;
  }
  const ordered = files.map((st) => map[st]).filter((u) => u && before.includes(u));
  let extras = before.filter((u) => !ordered.includes(u));
  if (ordered.length) extras = extras.filter((u) => !PLACEHOLDER_RE.test(u));
  let imgs = [...new Set([...ordered, ...extras])];
  if (!imgs.length) imgs = [before[0] || '/images/lot-bulk-commons.svg'];
  // photos we can't place: card has JSON photo names, but some uploaded files don't match any of them
  const mapped = new Set(Object.values(map));
  const unresolved = files.length ? imgs.filter((u) => isUpload(u) && !mapped.has(u)).length : 0;
  const cleanMap = Object.fromEntries(Object.entries(map).filter(([, u]) => imgs.includes(u)));
  const next = { ...product, images: imgs.slice(0, 20), image: imgs[0] };
  if (Object.keys(cleanMap).length) next.photo_map = cleanMap; else delete next.photo_map;
  const changed = JSON.stringify(before) !== JSON.stringify(next.images) ||
    JSON.stringify(product.photo_map || {}) !== JSON.stringify(cleanMap);
  return { product: next, changed, unresolved };
}

/**
 * Add freshly saved photos ([{ stem, url }]) to a card, replacing an older upload of the same
 * photo name, then sort. replaceAll drops all existing uploads/placeholders first (JSON import with photos).
 */
function applyPhotos(product, saved, { replaceAll = false } = {}) {
  const map = { ...(product.photo_map || {}) };
  let current = (product.images && product.images.length ? product.images : [product.image]).filter(Boolean);
  if (replaceAll) {
    current = current.filter((u) => !isUpload(u) && !PLACEHOLDER_RE.test(u));
    for (const k of Object.keys(map)) delete map[k];
  }
  for (const { stem, url } of saved) {
    if (map[stem] && map[stem] !== url) current = current.filter((u) => u !== map[stem]);
    map[stem] = url;
    if (!current.includes(url)) current.push(url);
  }
  current = current.filter((u) => u !== '/images/lot-bulk-commons.svg' || !saved.length);
  return orderImages({ ...product, images: current, photo_map: map }).product;
}

module.exports = { orderImages, applyPhotos, inferStem, PLACEHOLDER_RE };
