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

async function gh(cfg, repoFile, method, body) {
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
/** Commit JSON to the repo. Pushes are serialised so each uses a fresh sha. */
function pushJson(repoFile, value, message) {
  const cfg = ghConfig();
  if (!cfg) return Promise.resolve({ github: false });
  const content = Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64');
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

async function safePush(repoFile, value, message) {
  try {
    return await pushJson(repoFile, value, message);
  } catch (err) {
    console.error('GitHub sync failed:', err.message);
    return { github: false, githubError: err.message };
  }
}

module.exports = { ghConfig, pullJson, pushJson, safePush };
