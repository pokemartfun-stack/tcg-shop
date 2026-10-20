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

async function toJpeg(buffer, originalName) {
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
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
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
  const file = `${slugPart(prefix || originalName)}-${hash}.jpg`;
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

module.exports = { slugPart, savePhoto, toJpeg, baseName, stem, serveFromGitHub, uploadsDir, ALLOWED_EXT };
