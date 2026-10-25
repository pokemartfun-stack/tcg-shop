'use strict';
// Postage: every product has a Royal Mail Tracked 48 band (Large Letter / Small Parcel), taken
// from its Vinted parcel size when imported. An order is ONE Tracked 48 item, charged at the price
// of the LARGEST band in the basket (not per item). Prices are editable in admin (settings.postage).
// The server always works the postage out itself; the browser is never trusted with the amount.

// Royal Mail Tracked 48 formats we post in, smallest first. To offer another size later
// (e.g. Medium Parcel) add it here: the admin page, product dropdown and basket pick it up.
// Default prices = Royal Mail Tracked 48 ONLINE prices (Click & Drop) from 5 October 2026,
// https://www.royalmail.com/sending/uk/tracked-48 (checked 24 Oct 2026). Editable in admin.
const BANDS = [
  { id: 'Large Letter', limits: 'max 1kg · 35.3 × 25 × 2.5 cm', price: 2.9 },
  { id: 'Small Parcel', limits: 'max 2kg · 45 × 35 × 16 cm', price: 3.75 },
];
const BAND_IDS = BANDS.map((b) => b.id);

const DEFAULT_POSTAGE = {
  service: 'Royal Mail Tracked 48',
  bands: Object.fromEntries(BANDS.map((b) => [b.id, { price: b.price }])),
  free_over_enabled: false,
  free_over: 50,
};

const money = (n) => Math.round(Number(n) * 100) / 100;

/** Exact band name (any case / "large-letter" / "small_parcel"), else null. */
function parseBand(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return BAND_IDS.find((id) => id.toLowerCase() === s) || null;
}

/**
 * Vinted parcel size (Small / Medium / Large from the Vinted Listing Tool) -> Royal Mail band:
 * Small -> Large Letter; Medium, Large or anything bigger -> Small Parcel; missing -> null.
 */
function bandFromVinted(size) {
  const s = String(size == null ? '' : size).trim().toLowerCase();
  if (!s) return null;
  if (parseBand(s)) return parseBand(s);
  if (/^s(mall)?\b/.test(s) || /letter/.test(s)) return 'Large Letter';
  return 'Small Parcel';
}

/** Default band when a product has no size: cards and card lots fit a Large Letter; sealed products and accessories & merch go as a Small Parcel. */
const LARGE_LETTER_CATEGORIES = ['trading cards', 'trading card lots'];
function defaultBand(category) {
  return LARGE_LETTER_CATEGORIES.includes(String(category || 'Trading cards').trim().toLowerCase()) ? 'Large Letter' : 'Small Parcel';
}

/** The band stored on a product: its postage_band, else its Vinted postage_size, else by category. */
function bandForProduct(p) {
  const prod = p || {};
  return parseBand(prod.postage_band) || bandFromVinted(prod.postage_size) || defaultBand(prod.category);
}

function bandRank(band) {
  return BAND_IDS.indexOf(parseBand(band) || BAND_IDS[0]);
}

/** Validate + fill in postage settings from admin / settings.json. Returns { postage } or { error }. */
function validatePostage(input, base = DEFAULT_POSTAGE) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Postage settings must be an object' };
  const baseBands = (base && base.bands) || {};
  const out = {
    service: base.service || DEFAULT_POSTAGE.service,
    bands: Object.fromEntries(BANDS.map((b) => [b.id, { price: baseBands[b.id] && Number.isFinite(Number(baseBands[b.id].price)) ? money(baseBands[b.id].price) : b.price }])),
    free_over_enabled: Boolean(base.free_over_enabled),
    free_over: Number.isFinite(Number(base.free_over)) ? money(base.free_over) : DEFAULT_POSTAGE.free_over,
  };
  if (input.service !== undefined) {
    const v = String(input.service).trim().slice(0, 60);
    if (!v) return { error: 'Postage service name cannot be empty' };
    out.service = v;
  }
  if (input.bands !== undefined) {
    if (!input.bands || typeof input.bands !== 'object' || Array.isArray(input.bands)) return { error: 'Postage bands must be an object' };
    for (const b of BANDS) {
      const v = input.bands[b.id];
      if (v === undefined || v === null) continue;
      const raw = typeof v === 'object' ? v.price : v;
      const n = Number(raw);
      if (raw === '' || raw === undefined || !Number.isFinite(n) || n < 0 || n > 100) return { error: `${b.id} postage price must be between £0 and £100` };
      out.bands[b.id] = { price: money(n) };
    }
  }
  if (input.free_over_enabled !== undefined) {
    const v = input.free_over_enabled;
    out.free_over_enabled = v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
  }
  if (input.free_over !== undefined) {
    const v = Number(input.free_over);
    if (input.free_over === '' || !Number.isFinite(v) || v < 0 || v > 100000) return { error: 'Free postage threshold must be a number of pounds' };
    out.free_over = money(v);
  }
  return { postage: out };
}

/**
 * Postage for a basket: ONE Tracked 48 item, priced at the largest band among the lines.
 * @param items  [{ postage_band, qty }] (cart lines)
 * @param subtotal  items total in £
 * @returns { service, band, base_price, amount, free, free_over, subtotal, total }
 */
function quote(items, subtotal, settings) {
  const cfg = (settings && validatePostage(settings, settings).postage) || DEFAULT_POSTAGE;
  const lines = (items || []).filter((l) => l && (l.qty == null || l.qty > 0));
  const sub = money(subtotal || 0);
  const free_over = cfg.free_over_enabled ? cfg.free_over : null;
  if (!lines.length) {
    return { service: cfg.service, band: null, base_price: 0, amount: 0, free: false, free_over, subtotal: sub, total: sub };
  }
  const band = lines.reduce((best, l) => (bandRank(bandForProduct(l)) > bandRank(best) ? bandForProduct(l) : best), BAND_IDS[0]);
  const base_price = money(cfg.bands[band].price);
  const free = Boolean(cfg.free_over_enabled && sub >= cfg.free_over);
  const amount = free ? 0 : base_price;
  return { service: cfg.service, band, base_price, amount, free, free_over, subtotal: sub, total: money(sub + amount) };
}

// ---------- UK delivery address ----------
const POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2}$/;

function formatPostcode(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 5) return s;
  return `${s.slice(0, -3)} ${s.slice(-3)}`;
}

/** Validate a delivery address from checkout. Returns { address } or { error, field }. */
function validateAddress(input) {
  const a = input && typeof input === 'object' ? input : {};
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const address = {
    name: clean(a.name, 80),
    line1: clean(a.line1, 100),
    line2: clean(a.line2, 100),
    town: clean(a.town, 60),
    county: clean(a.county, 60),
    postcode: formatPostcode(a.postcode),
    country: 'United Kingdom',
    phone: clean(a.phone, 30),
  };
  if (!address.name) return { error: 'Enter the full name for delivery', field: 'name' };
  if (!address.line1) return { error: 'Enter the first line of the delivery address', field: 'line1' };
  if (!address.town) return { error: 'Enter the town or city', field: 'town' };
  if (!POSTCODE_RE.test(address.postcode)) return { error: 'Enter a valid UK postcode (e.g. SW1A 1AA)', field: 'postcode' };
  if (address.phone && !/^[+()\d\s-]{6,30}$/.test(address.phone)) return { error: 'Phone number can only contain digits, spaces, +, ( ) and -', field: 'phone' };
  return { address };
}

module.exports = { BANDS, BAND_IDS, DEFAULT_POSTAGE, parseBand, bandFromVinted, defaultBand, bandForProduct, bandRank, validatePostage, quote, validateAddress, formatPostcode, POSTCODE_RE };
