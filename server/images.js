'use strict';
// Photo uploads: convert (incl. HEIC) + resize/compress with sharp, store in public/uploads,
// mirror to GitHub (public/uploads/<file>) so photos survive Render free-tier restarts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sync = require('./github-sync');

let sharp = null;
try { sharp = require('sharp'); } catch { /* optional at require time; upload will report */ }

const MAX_SIDE = 1200;
const QUALITY = 80;
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,120}\.jpg$/;

function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
}

/** Lower-case basename of a Windows or POSIX path / URL, e.g. "D:\\a\\IMG_1.JPG" -> "img_1.jpg" */
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop().split('?')[0].trim().toLowerCase();
}

/** Basename without extension, so IMG_1.HEIC in JSON matches an uploaded IMG_1.jpg too. */
function stem(p) {
  return baseName(p).replace(/\.[a-z0-9]+$/, '');
}

function slugPart(s) {
  return String(s || 'photo').toLowerCase().replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'photo';
}

async function toJpeg(buffer, originalName, opts = {}) {
  if (!sharp) throw new Error('Image processing (sharp) is not installed on the server');
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    throw new Error(`${originalName}: only JPG, PNG, WebP or HEIC photos are supported`);
  }
  let input = buffer;
  const isHeic = ext === '.heic' || ext === '.heif' || /^....ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(buffer.subarray(0, 12).toString('latin1'));
  if (isHeic) {
    try {
      const convert = require('heic-convert');
      input = Buffer.from(await convert({ buffer, format: 'JPEG', quality: 0.92 }));
    } catch (err) {
      throw new Error(`${originalName}: could not read this HEIC photo (${err.message}). Export it as JPG and try again.`);
    }
  }
  try {
    return await sharp(input, { failOn: 'error' })
      .rotate() // respect EXIF orientation from phones
      .resize(opts.resize || { width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: opts.quality || QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    throw new Error(`${originalName}: not a readable image (${err.message})`);
  }
}

/**
 * Process + store one photo. Returns { url, file, github, githubError? }.
 * Filename includes a content hash so re-uploading the same photo is idempotent.
 */
async function savePhoto(buffer, originalName, prefix) {
  const jpeg = await toJpeg(buffer, originalName);
  const hash = crypto.createHash('sha1').update(jpeg).digest('hex').slice(0, 10);
  const base = String(prefix || '').startsWith('=') ? prefix.slice(1) : slugPart(prefix || originalName);
  const file = `${base}-${hash}.jpg`;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  const existed = fs.existsSync(full);
  if (!existed) fs.writeFileSync(full, jpeg);
  const pushed = existed && !sync.ghConfig()
    ? { github: false }
    : await sync.safePush(`public/uploads/${file}`, jpeg, `Admin: photo ${file}`, true);
  return { url: `/uploads/${file}`, file, bytes: jpeg.length, ...pushed };
}

/**
 * Express handler for /uploads/:file — local disk first (express.static runs before this),
 * then fetch from GitHub and cache to disk. Keeps photos working after a Render restart.
 */
async function serveFromGitHub(req, res, next) {
  const file = req.params.file;
  if (!FILE_RE.test(file)) return next();
  try {
    const buf = await sync.fetchFile(`public/uploads/${file}`);
    if (!buf) return next();
    try {
      fs.mkdirSync(uploadsDir(), { recursive: true });
      fs.writeFileSync(path.join(uploadsDir(), file), buf);
    } catch { /* cache best-effort */ }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch (err) {
    console.error('Photo fallback failed:', err.message);
    next();
  }
}

// ---------- Site images: banner + page background (local file + repo copy) ----------
// Each lives at public/images/<name>.jpg (or <name>.gif for GIF uploads, kept animated)
// locally AND in the GitHub repo, so the web design is portable to another host.
// Admin uploads are committed with [skip render], so after a Render restart the deployed
// copy can be older than the repo: with a token we therefore prefer the repo copy once per
// process (tracked per file name), then serve the local cache.
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MIME = { jpg: 'image/jpeg', gif: 'image/gif' };

function isGif(buffer, originalName) {
  return path.extname(String(originalName || '')).toLowerCase() === '.gif' ||
    /^GIF8[79]a/.test(buffer.subarray(0, 6).toString('latin1'));
}

/**
 * GIF → GIF, frames + timing preserved. Small enough GIFs are passed through untouched
 * (best quality); wider ones are resized to maxWidth with sharp's animated GIF encoder.
 */
async function toGif(buffer, originalName, maxWidth) {
  if (buffer.length > MAX_GIF_BYTES) {
    throw new Error(`${originalName}: GIF is ${(buffer.length / 1048576).toFixed(1)} MB — please keep GIFs under 8 MB (shorter clip or smaller size)`);
  }
  if (!sharp) throw new Error('Image processing (sharp) is not installed on the server');
  let meta;
  try { meta = await sharp(buffer, { animated: true }).metadata(); } catch (err) {
    throw new Error(`${originalName}: not a readable GIF (${err.message})`);
  }
  if (meta.format !== 'gif') throw new Error(`${originalName}: not a GIF file`);
  const frames = meta.pages || 1;
  if (!meta.width || meta.width <= maxWidth) return { data: buffer, frames, width: meta.width, resized: false };
  const out = await sharp(buffer, { animated: true })
    .resize({ width: maxWidth, withoutEnlargement: true })
    .gif({ effort: 7 })
    .toBuffer();
  if (out.length > MAX_GIF_BYTES) {
    throw new Error(`${originalName}: GIF is still over 8 MB after resizing — please use a shorter or smaller GIF`);
  }
  return { data: out, frames, width: maxWidth, resized: true };
}

function siteImage(name, envVar, label, resize, quality, gifMaxWidth) {
  const repoPath = (ext) => `public/images/${name}.${ext}`;
  // BANNER_FILE / BACKGROUND_FILE (tests) name the .jpg; the .gif sits next to it.
  const localFile = (ext = 'jpg') => {
    const jpg = process.env[envVar] || path.join(__dirname, '..', 'public', 'images', `${name}.jpg`);
    return ext === 'jpg' ? jpg : jpg.replace(/\.jpe?g$/i, '') + `.${ext}`;
  };
  const fresh = { jpg: false, gif: false };

  async function save(buffer, originalName) {
    let data, ext, extra = {};
    if (isGif(buffer, originalName)) {
      const g = await toGif(buffer, originalName, gifMaxWidth);
      data = g.data; ext = 'gif'; extra = { frames: g.frames, animated: g.frames > 1 };
    } else {
      data = await toJpeg(buffer, originalName, { resize, quality }); ext = 'jpg';
    }
    const file = localFile(ext);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    fresh[ext] = true;
    const pushed = await sync.safePush(repoPath(ext), data, `Admin: ${label}${ext === 'gif' ? ' (GIF)' : ''}`, true);
    return { url: `/images/${name}.${ext}?v=${Date.now()}`, path: `/images/${name}.${ext}`, ext, bytes: data.length, ...extra, ...pushed };
  }

  /** Express handler factory: serve('jpg') for /images/<name>.jpg, serve('gif') for .gif */
  function serveExt(ext) {
    return async function serve(_req, res, next) {
      const file = localFile(ext);
      const send = (buf) => {
        res.setHeader('Content-Type', MIME[ext]);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // URL carries ?v=<timestamp>
        res.end(buf);
      };
      const cache = (buf) => {
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); } catch { /* best-effort */ }
      };
      try {
        if (!fresh[ext] && sync.ghConfig()) {
          try {
            const buf = await sync.fetchFile(repoPath(ext));
            fresh[ext] = true;
            if (buf) { cache(buf); return send(buf); }
          } catch (err) { console.error(`${label} refresh from GitHub failed:`, err.message); }
        }
        if (fs.existsSync(file)) return send(fs.readFileSync(file));
        const buf = await sync.fetchFile(repoPath(ext));
        if (!buf) return next();
        cache(buf);
        send(buf);
      } catch (err) {
        console.error(`${label} fallback failed:`, err.message);
        next();
      }
    };
  }

  const serveJpg = serveExt('jpg');
  const serveGif = serveExt('gif');
  return { save, serve: serveJpg, serveGif, file: localFile, repoPath };
}

const banner = siteImage('banner', 'BANNER_FILE', 'shop banner image',
  { width: 2000, withoutEnlargement: true }, 82, 2000);
// Page background: whole image kept (no crop), max 2400px side; CSS scales it to cover.
const background = siteImage('background', 'BACKGROUND_FILE', 'page background image',
  { width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }, 86, 2400);

const saveBanner = banner.save;
const serveBanner = banner.serve;
const serveBannerGif = banner.serveGif;
const bannerFile = banner.file;
const saveBackground = background.save;
const serveBackground = background.serve;
const serveBackgroundGif = background.serveGif;
const backgroundFile = background.file;

function slugFull(s, max) {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'photo';
}

/** File name base for a card photo: "<id≤48>-<photo name≤40>" — never truncates the photo name away. */
function photoBase(id, photoStem) {
  return `${slugFull(id, 48)}-${slugFull(photoStem, 40)}`;
}

module.exports = { photoBase, slugFull, saveBanner, serveBanner, serveBannerGif, bannerFile, saveBackground, serveBackground, serveBackgroundGif, backgroundFile, toGif, isGif, MAX_GIF_BYTES, slugPart, savePhoto, toJpeg, baseName, stem, serveFromGitHub, uploadsDir, ALLOWED_EXT };
