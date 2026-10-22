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

  return { CATEGORIES, TABS, DEFAULT_TAB, normaliseCategory, tabForCategory, parseTab, getTab, productsInTab };
});
