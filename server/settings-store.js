'use strict';
// Shop settings (hero banner image + tagline): data/settings.json, synced to GitHub like products.
const fs = require('fs');
const path = require('path');
const sync = require('./github-sync');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'settings.json');
const REPO_FILE = 'data/settings.json';
const DEFAULTS = {
  shop_name: 'Po-ke Mart Fun',
  tagline: 'Pokémon TCG singles & lots — fair prices, fast UK postage.',
  banner_image: '',
};

function filePath() {
  return process.env.SETTINGS_FILE || DEFAULT_PATH;
}

let cache = null;

function get() {
  if (!cache) {
    let fromFile = {};
    try { fromFile = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch { /* defaults */ }
    cache = { ...DEFAULTS, ...validate(fromFile).settings };
  }
  return cache;
}

function reset() { cache = null; }

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Settings must be an object' };
  const out = {};
  if (input.shop_name !== undefined) {
    const v = String(input.shop_name).trim().slice(0, 60);
    if (!v) return { error: 'Shop name cannot be empty' };
    out.shop_name = v;
  }
  if (input.tagline !== undefined) out.tagline = String(input.tagline).trim().slice(0, 160);
  if (input.banner_image !== undefined) {
    const v = String(input.banner_image).trim();
    if (v && !/^(https?:\/\/|\/)/i.test(v)) return { error: 'Banner image must be an https:// URL or /path (or blank)' };
    if (/["'()\\\s]/.test(v)) return { error: 'Banner image URL contains invalid characters' };
    out.banner_image = v;
  }
  return { settings: out };
}

async function update(patch) {
  const v = validate(patch);
  if (v.error) return { error: v.error };
  cache = { ...get(), ...v.settings };
  fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2) + '\n', 'utf8');
  const s = await sync.safePush(REPO_FILE, cache, 'Admin: update shop settings');
  return { settings: cache, ...s };
}

async function pullFromGitHub() {
  const remote = await sync.pullJson(REPO_FILE);
  if (!remote) return false;
  const v = validate(remote);
  if (v.error) throw new Error(`GitHub settings.json invalid: ${v.error}`);
  cache = { ...DEFAULTS, ...v.settings };
  try { fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2) + '\n'); } catch { /* ignore */ }
  return true;
}

module.exports = { get, reset, update, validate, pullFromGitHub, DEFAULTS };
