/* Shop sections ("tabs") and product categories. Shared by the browser (window.TCGCategories)
   and the server (require('../public/js/categories')), so the shop page, the admin page and the
   JSON importer always agree on which tab a product belongs to. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCGCategories = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACC = 'Accessories & Merch';
  const CATEGORIES = ['Trading cards', 'Trading card lots', 'Sealed products', ACC];

  const TABS = [
    { id: 'cards', label: 'Cards & Lots', categories: ['Trading cards', 'Trading card lots'],
      noun: 'card', empty: 'No cards yet — check back soon' },
    { id: 'sealed', label: 'Sealed Products', categories: ['Sealed products'],
      noun: 'item', empty: 'No sealed products yet — check back soon' },
    { id: 'accessories', label: ACC, categories: [ACC],
      noun: 'item', empty: 'No accessories or merch yet — check back soon' },
  ];
  const DEFAULT_TAB = 'cards';

  // Checked in this order: "deck box" is an accessory, "booster box" is sealed.
  // Accessories & Merch = card supplies (sleeves, binders, deck boxes, playmats ...) and
  // merchandise (figures, models, plushies, toys, cushions, keyrings, clothing ...).
  const ACCESSORY_WORDS = /accessor|merch|sleeve|binder|top ?loader|playmat|play mat|deck ?box|deck case|card case|portfolio|storage|supplies|\bdice\b|\bcoins?\b|figur|\bmodels?\b|plush|soft toy|cushion|pillow|keyring|key ring|\btoys?\b|poster|sticker|badge|pin badge|t-?shirt|hoodie|clothing|\bmugs?\b/i;
  const SEALED_WORDS = /sealed|booster|\bbox|\bboxes|\betb\b|elite trainer|\btins?\b|blister|\bpacks?\b|collection box|premium collection/i;
  const LOT_WORDS = /\blots?\b|bundle|bulk/i;

  /**
   * Turn any category text (shop value, Vinted "Hobbies & Collectables > Trading cards",
   * "Booster boxes", "card sleeves" ...) into one of CATEGORIES. Unknown -> "Trading cards".
   */
  function normaliseCategory(v) {
    const full = String(v == null ? '' : v).trim();
    const last = full.split('>').pop().trim();
    if (!last) return 'Trading cards';
    const exact = CATEGORIES.find((c) => c.toLowerCase() === last.toLowerCase());
    if (exact) return exact;
    if (ACCESSORY_WORDS.test(last)) return ACC;
    if (SEALED_WORDS.test(last)) return 'Sealed products';
    if (LOT_WORDS.test(last)) return 'Trading card lots';
    return 'Trading cards';
  }

  /** Tab id for a product category. Anything not sealed / accessories & merch lives in Cards & Lots. */
  function tabForCategory(category) {
    const c = normaliseCategory(category).toLowerCase();
    const tab = TABS.find((t) => t.categories.some((x) => x.toLowerCase() === c));
    return tab ? tab.id : DEFAULT_TAB;
  }

  /** "?tab=sealed" value -> a valid tab id (default cards). Accepts ids or labels, any case. */
  function parseTab(v) {
    const s = String(v || '').trim().toLowerCase();
    const tab = TABS.find((t) => t.id === s || t.label.toLowerCase() === s);
    return tab ? tab.id : DEFAULT_TAB;
  }

  function getTab(id) {
    return TABS.find((t) => t.id === id) || TABS[0];
  }

  function productsInTab(products, tabId) {
    const id = parseTab(tabId);
    return (products || []).filter((p) => tabForCategory(p && p.category) === id);
  }

  /**
   * Parse a category the admin explicitly chose (add/edit form or JSON import override).
   * Empty -> { ok: true, category: null } (keep the file's category / default).
   * A known category, a single-category tab id/label, or a known alias -> { ok: true, category }.
   * Anything else -> { ok: false, error } (do not silently fall back to Trading cards).
   */
  function parseExplicitCategory(v) {
    const full = String(v == null ? '' : v).trim();
    if (!full) return { ok: true, category: null };
    const last = full.split('>').pop().trim();
    const exact = CATEGORIES.find((c) => c.toLowerCase() === last.toLowerCase());
    if (exact) return { ok: true, category: exact };
    const tab = TABS.find((t) => t.id === last.toLowerCase() || t.label.toLowerCase() === last.toLowerCase());
    if (tab) {
      // Cards & Lots covers two categories, so the tab name alone is not a valid override
      if (tab.categories.length === 1) return { ok: true, category: tab.categories[0] };
      return { ok: false, error: 'Category must be one of: ' + CATEGORIES.join(', ') };
    }
    if (ACCESSORY_WORDS.test(last)) return { ok: true, category: ACC };
    if (SEALED_WORDS.test(last)) return { ok: true, category: 'Sealed products' };
    if (LOT_WORDS.test(last)) return { ok: true, category: 'Trading card lots' };
    return { ok: false, error: 'Category must be one of: ' + CATEGORIES.join(', ') };
  }

  return { CATEGORIES, TABS, DEFAULT_TAB, normaliseCategory, parseExplicitCategory, tabForCategory, parseTab, getTab, productsInTab };
});
