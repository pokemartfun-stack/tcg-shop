'use strict';
// Minimal GitHub Contents API helper used to persist JSON data files
// (products.json, settings.json) on hosts with an ephemeral disk (Render free tier).

function ghConfig() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    token,
    repo: process.env.GITHUB_REPO || 'pokemartfun-stack/tcg-shop',
    branch: process.env.GITHUB_BRANCH || 'main',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastWrite = 0;
// GitHub limits content-creating requests (~80/min). Pace writes and retry on rate limits.
const WRITE_GAP_MS = Number(process.env.GITHUB_WRITE_GAP_MS || 900);

async function gh(cfg, repoFile, method, body, attempt = 0) {
  if (method !== 'GET') {
    const wait = lastWrite + WRITE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastWrite = Date.now();
  }
  try {
    return await ghOnce(cfg, repoFile, method, body);
  } catch (err) {
    const limited = err.status === 429 || (err.status === 403 && /rate limit|secondary/i.test(err.message));
    if (limited && attempt < 4) {
      await sleep(err.retryAfter ? err.retryAfter * 1000 : 15000 * (attempt + 1));
      return gh(cfg, repoFile, method, body, attempt + 1);
    }
    throw err;
  }
}

async function ghOnce(cfg, repoFile, method, body) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${repoFile}` +
    (method === 'GET' ? `?ref=${encodeURIComponent(cfg.branch)}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tcg-shop-admin',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${repoFile} ${res.status}: ${data.message || 'error'}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw err;
  }
  return data;
}

/** Returns parsed JSON from the repo, or null if no token / file missing (404). */
async function pullJson(repoFile) {
  const cfg = ghConfig();
  if (!cfg) return null;
  try {
    const data = await gh(cfg, repoFile, 'GET');
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

let chain = Promise.resolve();
/** Commit raw bytes to the repo. Pushes are serialised so each uses a fresh sha. */
function pushContent(repoFile, buffer, message) {
  const cfg = ghConfig();
  if (!cfg) return Promise.resolve({ github: false });
  const content = Buffer.from(buffer).toString('base64');
  chain = chain.catch(() => {}).then(async () => {
    let sha;
    try { sha = (await gh(cfg, repoFile, 'GET')).sha; } catch { sha = undefined; }
    await gh(cfg, repoFile, 'PUT', {
      // "[skip render]" is Render's documented skip phrase: no redeploy for data-only commits.
      message: `[skip render] ${message}`,
      content,
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    });
    return { github: true };
  });
  return chain;
}

function pushJson(repoFile, value, message) {
  return pushContent(repoFile, Buffer.from(JSON.stringify(value, null, 2) + '\n'), message);
}

/**
 * Download a file's bytes from the repo (works for private repos via the token;
 * falls back to raw.githubusercontent.com for public repos without a token).
 * Returns a Buffer or null if not found.
 */
async function fetchFile(repoFile) {
  const cfg = ghConfig();
  const repo = (cfg && cfg.repo) || process.env.GITHUB_REPO || 'pokemartfun-stack/tcg-shop';
  const branch = (cfg && cfg.branch) || process.env.GITHUB_BRANCH || 'main';
  const url = cfg
    ? `https://api.github.com/repos/${repo}/contents/${repoFile}?ref=${encodeURIComponent(branch)}`
    : `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${repoFile}`;
  const headers = cfg
    ? { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'tcg-shop' }
    : { 'User-Agent': 'tcg-shop' };
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub fetch ${repoFile} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function safePush(repoFile, value, message, raw = false) {
  try {
    return await (raw ? pushContent(repoFile, value, message) : pushJson(repoFile, value, message));
  } catch (err) {
    console.error('GitHub sync failed:', err.message);
    return { github: false, githubError: err.message };
  }
}

module.exports = { ghConfig, pullJson, pushJson, pushContent, fetchFile, safePush };
