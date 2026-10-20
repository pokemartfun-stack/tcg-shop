(function () {
  const $ = (s) => document.querySelector(s);
  let token = sessionStorage.getItem('adminToken') || '';

  function msg(text, ok) {
    const el = $('#msg');
    el.textContent = text || '';
    el.className = ok ? 'ok' : 'err';
    if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function api(method, url, body) {
    const res = await fetch('/api/admin' + url, {
      method,
      headers: {
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) showLogin();
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (HTTP ${res.status}${res.status === 413 ? ': file too large' : ''})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function syncNote(d) {
    if (d.githubError) return ' (saved live, but GitHub save failed: ' + d.githubError + ')';
    return d.github ? ' (saved to GitHub)' : '';
  }

  function showLogin() {
    token = '';
    sessionStorage.removeItem('adminToken');
    $('#panel').hidden = true;
    $('#login-box').hidden = false;
  }

  async function showPanel() {
    const st = await api('GET', '/status');
    $('#sync').textContent = st.github
      ? 'Changes save to GitHub: ' + st.github.repo
      : 'GitHub sync OFF – changes are lost when the server restarts';
    $('#login-box').hidden = true;
    $('#panel').hidden = false;
    await Promise.all([render(), loadSettings()]);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let LAST = [];

  async function render() {
    LAST = await api('GET', '/products');
    const oos = LAST.filter((p) => p.stock < 1);
    $('#count').textContent = LAST.length;
    $('#oos-count').textContent = oos.length ? oos.length + ' out of stock' : 'all in stock';
    const onlyOos = $('#only-oos').checked;
    // out-of-stock first so they're easy to spot
    const rows = LAST.slice().sort((a, b) => (a.stock < 1 ? 0 : 1) - (b.stock < 1 ? 0 : 1))
      .filter((p) => !onlyOos || p.stock < 1);
    $('#rows').innerHTML = rows.map((p) => `
      <tr data-id="${esc(p.id)}" class="${p.stock < 1 ? 'out' : ''}">
        <td class="rowphotos">
          <div class="thumbs">${(p.images && p.images.length ? p.images : [p.image]).map((u, i) => `
            <span class="t"><img src="${esc(u)}" alt="" loading="lazy" />${u.startsWith('/images/') && (p.images || []).length <= 1 ? '' : `<button type="button" data-act="rmimg" data-idx="${i}" title="Remove photo">×</button>`}</span>`).join('')}</div>
          <label class="btnlike" style="font-size:12px;cursor:pointer;color:#60a5fa">Upload photo(s)<input type="file" multiple data-act="addimg" accept="image/jpeg,image/png,image/webp,.heic,.heif,.jpg,.jpeg,.png,.webp" /></label>
        </td>
        <td>${esc(p.id)}</td>
        <td>${esc(p.title)} ${p.stock < 1 ? '<span class="oos">OUT OF STOCK</span>' : ''}<br><small>${esc(p.condition)} · ${esc(p.category)}</small></td>
        <td><input class="small" type="number" step="0.01" min="0" data-f="price_gbp" value="${p.price_gbp}" /></td>
        <td><input class="small" type="number" step="1" min="0" data-f="stock" value="${p.stock}" /></td>
        <td class="stockctl">
          <button class="ghost" data-act="delta" data-delta="-1" title="Remove one">−1</button>
          <button class="ghost" data-act="delta" data-delta="1" title="Add one">+1</button>
          <input class="tiny" type="number" min="1" step="1" value="5" data-f="restock" aria-label="Restock amount" />
          <button data-act="restock">Restock +N</button>
        </td>
        <td><button data-act="save">Save</button> <button class="danger" data-act="del">Remove</button></td>
      </tr>`).join('') || '<tr><td colspan="7">No cards to show.</td></tr>';
  }

  $('#only-oos').addEventListener('change', render);

  // Per-card "Upload photo(s)"
  $('#rows').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-act=addimg]');
    if (!input || !input.files.length) return;
    const id = input.closest('tr').dataset.id;
    const fd = new FormData();
    imagesOnly([...input.files]).forEach((f) => fd.append('photos', f, f.name));
    msg('Uploading photos for ' + id + '…', true);
    try {
      const d = await api('POST', '/products/' + encodeURIComponent(id) + '/images', fd);
      msg('Photos added to ' + id + syncNote(d) + (d.warnings && d.warnings.length ? '\n' + d.warnings.join('\n') : ''), true);
      await render();
    } catch (err) { msg(err.message); }
  });

  $('#rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'rmimg') {
        const p = LAST.find((x) => x.id === id);
        const imgs = (p.images || [p.image]).filter((_, i) => i !== Number(btn.dataset.idx));
        const d = await api('PATCH', '/products/' + encodeURIComponent(id), { images: imgs, image: imgs[0] || '' });
        msg('Photo removed from ' + id + syncNote(d), true);
      } else if (act === 'del') {
        if (!confirm('Remove ' + id + ' from the shop?')) return;
        const d = await api('DELETE', '/products/' + encodeURIComponent(id));
        msg('Removed ' + id + syncNote(d), true);
      } else if (act === 'delta' || act === 'restock') {
        const delta = act === 'delta' ? Number(btn.dataset.delta) : Math.floor(Number(tr.querySelector('[data-f=restock]').value));
        if (!Number.isInteger(delta) || delta === 0) return msg('Enter a whole number to restock');
        const d = await api('POST', '/products/' + encodeURIComponent(id) + '/stock', { delta });
        msg(id + ' now has ' + d.product.stock + ' in stock' + syncNote(d), true);
      } else if (act === 'save') {
        const body = {
          price_gbp: Number(tr.querySelector('[data-f=price_gbp]').value),
          stock: Number(tr.querySelector('[data-f=stock]').value),
        };
        const d = await api('PATCH', '/products/' + encodeURIComponent(id), body);
        msg('Updated ' + id + ' (£' + d.product.price_gbp.toFixed(2) + ', ' + d.product.stock + ' in stock)' + syncNote(d), true);
      }
      await render();
    } catch (err) { msg(err.message); }
    finally { btn.disabled = false; }
  });

  // Enter in the quantity box = Save
  $('#rows').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      const tr = e.target.closest('tr');
      tr.querySelector(e.target.dataset.f === 'restock' ? '[data-act=restock]' : '[data-act=save]').click();
    }
  });

  function previewBanner() {
    const f = $('#settings-form');
    const pv = $('#banner-preview');
    pv.textContent = (f.shop_name.value || 'Po-ke Mart Fun') + (f.tagline.value ? ' — ' + f.tagline.value : '');
    const url = f.banner_image.value.trim();
    pv.style.backgroundImage = /^(https?:\/\/|\/)[^"'()\s\\]*$/i.test(url)
      ? `linear-gradient(90deg,#000a,#0003),url("${encodeURI(url)}")`
      : '';
  }

  async function loadSettings() {
    const st = await api('GET', '/settings');
    const f = $('#settings-form');
    f.shop_name.value = st.shop_name || '';
    f.tagline.value = st.tagline || '';
    f.banner_image.value = st.banner_image || '';
    previewBanner();
  }

  $('#settings-form').addEventListener('input', previewBanner);

  // ---- Banner image upload (stored as /images/banner.jpg in the repo) ----
  function bannerResult(text, ok) {
    const el = $('#banner-result');
    el.textContent = text || '';
    el.className = 'result ' + (ok ? 'ok' : 'err');
  }

  async function uploadBanner(file) {
    if (!file) return;
    if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return bannerResult(`${file.name}: please use a JPG, PNG, WebP or HEIC image`);
    // instant local preview (browsers can't show HEIC; the server preview follows)
    if (!/\.hei[cf]$/i.test(file.name)) {
      const local = URL.createObjectURL(file);
      $('#banner-preview').style.backgroundImage = `linear-gradient(90deg,#000a,#0003),url("${local}")`;
    }
    bannerResult('Uploading banner…', true);
    const fd = new FormData();
    fd.append('banner', file, file.name);
    try {
      const d = await api('POST', '/settings/banner', fd);
      $('#settings-form').banner_image.value = d.settings.banner_image;
      previewBanner();
      bannerResult(`Banner saved (${Math.round(d.bytes / 1024)} KB)` + syncNote(d) + ' — live on the shop now.', !d.githubError);
    } catch (err) {
      bannerResult('Banner upload failed: ' + err.message);
      previewBanner();
    }
  }

  $('#banner-file').addEventListener('change', (e) => { uploadBanner(e.target.files[0]); e.target.value = ''; });
  const bdrop = $('#banner-drop');
  ['dragenter', 'dragover'].forEach((ev) => bdrop.addEventListener(ev, (e) => { e.preventDefault(); bdrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => bdrop.addEventListener(ev, (e) => { e.preventDefault(); bdrop.classList.remove('over'); }));
  bdrop.addEventListener('drop', (e) => uploadBanner([...(e.dataTransfer.files || [])].find((f) => /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) || e.dataTransfer.files[0]));
  $('#banner-remove').addEventListener('click', async () => {
    if (!confirm('Remove the banner image and go back to the coloured pattern?')) return;
    try {
      const d = await api('DELETE', '/settings/banner');
      $('#settings-form').banner_image.value = '';
      previewBanner();
      bannerResult('Banner image removed' + syncNote(d), true);
    } catch (err) { bannerResult(err.message); }
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const d = await api('PUT', '/settings', body);
      msg('Banner saved' + syncNote(d), true);
    } catch (err) { msg(err.message); }
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await api('POST', '/login', { password: $('#pw').value });
      token = d.token;
      sessionStorage.setItem('adminToken', token);
      $('#pw').value = '';
      msg('');
      await showPanel();
    } catch (err) { msg(err.message); }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/logout'); } catch {}
    showLogin();
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const files = imagesOnly(form.getAll('photos').filter((f) => f && f.size));
    form.delete('photos');
    const body = Object.fromEntries(form.entries());
    body.price_gbp = Number(body.price_gbp);
    body.stock = Number(body.stock);
    try {
      const d = await api('POST', '/products', body);
      let note = '';
      if (files.length) {
        const fd = new FormData();
        files.forEach((f) => fd.append('photos', f, f.name));
        fd.append('mode', body.image ? 'append' : 'replace');
        try { await api('POST', '/products/' + encodeURIComponent(d.product.id) + '/images', fd); note = ` with ${files.length} photo(s)`; }
        catch (err) { note = ' — but photos failed: ' + err.message; }
      }
      msg('Added ' + d.product.id + note + syncNote(d), !note.includes('failed'));
      e.target.reset();
      await render();
    } catch (err) { msg(err.message); }
  });

  // ---------------- Photos: pickers, drag & drop, matching preview, batched upload ----------------
  const IMG_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
  const BATCH_FILES = 4;
  const BATCH_BYTES = 30 * 1024 * 1024;
  const stemOf = (p) => String(p || '').split(/[\\/]/).pop().split('?')[0].trim().toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const isUrlRef = (u) => /^(https?:\/\/|\/)/i.test(u) && !/^\/(home|users|mnt|var|tmp)\//i.test(u);
  function imagesOnly(files) { return files.filter((f) => IMG_EXT.test(f.name)); }

  /** Reads every file inside dropped folders (Chrome/Edge/Firefox/Safari). */
  async function filesFromDrop(dt) {
    const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }

  /** Wire a drop zone + "Choose photos" + "Choose whole folder" + clear. Calls onChange(files). */
  function photoPicker(prefix, onChange) {
    let files = [];
    const set = (list, add) => {
      const imgs = imagesOnly(list);
      const skipped = list.length - imgs.length;
      const merged = add ? [...files, ...imgs] : imgs;
      const seen = new Set();
      files = merged.filter((f) => { const k = f.name.toLowerCase() + '|' + f.size; if (seen.has(k)) return false; seen.add(k); return true; });
      onChange(files, skipped);
    };
    const zone = $('#' + prefix + '-drop');
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', async (e) => set(await filesFromDrop(e.dataTransfer), true));
    $('#' + prefix + '-photos').addEventListener('change', (e) => { set([...e.target.files], true); e.target.value = ''; });
    $('#' + prefix + '-folder').addEventListener('change', (e) => { set([...e.target.files], true); e.target.value = ''; });
    $('#' + prefix + '-clear-photos').addEventListener('click', () => set([], false));
    return { get: () => files, clear: () => set([], false) };
  }

  function progress(prefix, done, total, text) {
    $('#' + prefix + '-progress').hidden = total === 0;
    $('#' + prefix + '-bar').max = Math.max(1, total);
    $('#' + prefix + '-bar').value = done;
    $('#' + prefix + '-status').textContent = text || `${done} / ${total}`;
  }

  function result(prefix, text, ok) {
    const el = $('#' + prefix + '-result');
    el.textContent = text || '';
    el.className = 'result ' + (ok ? 'ok' : 'err');
    if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function batches(files) {
    const out = [];
    let cur = [], bytes = 0;
    for (const f of files) {
      if (cur.length && (cur.length >= BATCH_FILES || bytes + f.size > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
      cur.push(f); bytes += f.size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Send photos in small sequential requests so 100+ photos never hit body limits. */
  async function sendPhotosInBatches(prefix, files) {
    const results = [];
    let done = 0;
    progress(prefix, 0, files.length, `Uploading photos 0 / ${files.length}…`);
    for (const group of batches(files)) {
      const fd = new FormData();
      group.forEach((f) => fd.append('photos', f, f.name));
      try {
        const d = await api('POST', '/photos/bulk', fd);
        results.push(...d.results);
        if (d.githubError) results.push({ name: '(GitHub)', warning: d.githubError });
      } catch (err) {
        group.forEach((f) => results.push({ name: f.name, card: null, error: err.message }));
      }
      done += group.length;
      progress(prefix, done, files.length, `Uploading photos ${done} / ${files.length}…`);
    }
    progress(prefix, done, files.length, `Photos done: ${done} / ${files.length}`);
    return results;
  }

  function photoReport(results) {
    const ok = results.filter((r) => r.card && !r.error);
    const bad = results.filter((r) => r.error);
    const warn = results.filter((r) => r.warning);
    let t = `${ok.length} photo(s) saved.`;
    if (bad.length) t += `\n${bad.length} photo(s) failed:\n` + bad.map((r) => `• ${r.name}: ${r.error}`).join('\n');
    if (warn.length) t += '\n' + warn.map((r) => `⚠ ${r.name}: ${r.warning}`).join('\n');
    return { text: t, ok: !bad.length };
  }

  // ---- JSON + photos import ----
  let importCards = null; // parsed JSON preview: [{ title, stems: [] }]
  let importJsonError = '';
  const importPicker = photoPicker('import', () => renderImportPreview());

  function cardsFromJson(data) {
    const list = Array.isArray(data) ? data : (data && (data.products || data.listings)) || null;
    if (!Array.isArray(list)) throw new Error('The file must contain a list of cards: [ {...}, {...} ]');
    return list.map((it, i) => {
      const refs = [];
      if (it && typeof it === 'object') {
        [it.image, it.photo].forEach((r) => r && refs.push(r));
        [it.images, it.photos].forEach((a) => Array.isArray(a) && refs.push(...a));
      }
      const stems = [...new Set(refs.filter((r) => typeof r === 'string' && r && !isUrlRef(r)).map(stemOf))];
      return { n: i + 1, title: (it && it.title) || `(item ${i + 1})`, stems };
    });
  }

  $('#json-file').addEventListener('change', async (e) => {
    importCards = null; importJsonError = '';
    const f = e.target.files[0];
    result('import', '');
    if (f) {
      try { importCards = cardsFromJson(JSON.parse((await f.text()).replace(/^\uFEFF/, ''))); }
      catch (err) { importJsonError = `${f.name}: ${err.message}`; }
    }
    renderImportPreview();
  });

  function importMatch() {
    const photos = importPicker.get();
    const byStem = new Map(photos.map((f) => [stemOf(f.name), f]));
    const used = new Set();
    const rows = (importCards || []).map((c) => {
      const matched = c.stems.filter((s) => byStem.has(s));
      matched.forEach((s) => used.add(byStem.get(s)));
      return { ...c, matched, missing: c.stems.filter((s) => !byStem.has(s)) };
    });
    return { rows, photos, matchedFiles: photos.filter((f) => used.has(f)), unmatched: photos.filter((f) => !used.has(f)) };
  }

  function renderImportPreview() {
    const box = $('#import-preview');
    if (importJsonError) { box.innerHTML = `<p class="bad"><strong>${esc(importJsonError)}</strong></p>`; return; }
    const m = importMatch();
    if (!importCards && !m.photos.length) { box.innerHTML = ''; return; }
    const noPhotoCards = m.rows.filter((r) => r.stems.length && !r.matched.length).length;
    let h = `<p><strong>${importCards ? m.rows.length + ' card(s) in file' : 'No JSON chosen yet'}</strong> · ${m.photos.length} photo(s) selected`;
    if (importCards) h += ` · <span class="good">${m.matchedFiles.length} matched</span> · <span class="${m.unmatched.length ? 'bad' : ''}">${m.unmatched.length} unmatched photo(s)</span> · <span class="${noPhotoCards ? 'bad' : ''}">${noPhotoCards} card(s) with no photo</span>`;
    h += '</p>';
    if (importCards) {
      h += '<table><thead><tr><th>#</th><th>Card</th><th>Photos</th><th>Missing</th></tr></thead><tbody>' +
        m.rows.map((r) => `<tr><td>${r.n}</td><td>${esc(r.title)}</td>
          <td class="${r.stems.length && r.matched.length === r.stems.length ? 'good' : r.stems.length ? 'bad' : ''}">${r.matched.length} / ${r.stems.length}</td>
          <td class="bad">${esc(r.missing.join(', '))}</td></tr>`).join('') + '</tbody></table>';
    }
    if (importCards && m.unmatched.length) h += `<p class="bad">Not used by any card: ${esc(m.unmatched.map((f) => f.name).join(', '))}</p>`;
    box.innerHTML = h;
  }

  $('#upload-btn').addEventListener('click', async () => {
    const btn = $('#upload-btn');
    const f = $('#json-file').files[0];
    result('import', '');
    if (!f) return result('import', 'Choose a .json file first (step 1).');
    if (importJsonError) return result('import', importJsonError);
    const mode = document.querySelector('input[name=mode]:checked').value;
    if (mode === 'replace' && !confirm(`Replace ALL cards with the ${(importCards || []).length} in this file?`)) return;
    const m = importMatch();
    btn.disabled = true;
    try {
      progress('import', 0, 1, 'Uploading cards…');
      const fd = new FormData();
      fd.append('mode', mode);
      fd.append('photos_follow', m.matchedFiles.length ? '1' : '');
      fd.append('file', f, f.name);
      let d;
      try {
        d = await api('POST', '/upload', fd);
      } catch (err) {
        progress('import', 0, 0);
        return result('import', 'Upload failed:\n' + err.message);
      }
      let text = `Cards: ${d.added} added, ${d.updated} updated, ${d.total} in shop` + syncNote(d);
      if (d.errors && d.errors.length) text += `\n\n${d.errors.length} item(s) skipped:\n` + d.errors.map((e) => `• #${e.item} ${e.title}: ${e.error}`).join('\n');
      const warn = (d.warnings || []);
      let ok = !(d.errors && d.errors.length);
      if (m.matchedFiles.length) {
        const rep = photoReport(await sendPhotosInBatches('import', m.matchedFiles));
        text += '\n\n' + rep.text;
        ok = ok && rep.ok;
      } else {
        progress('import', 1, 1, 'Done');
      }
      if (m.unmatched.length) text += `\n\nNot uploaded (no card uses them): ${m.unmatched.map((x) => x.name).join(', ')}`;
      if (warn.length) text += '\n\n' + warn.map((w) => '⚠ ' + w).join('\n');
      result('import', text, ok);
      msg(ok ? 'Import finished' : 'Import finished with problems — see the details in the upload section', ok);
      $('#json-file').value = '';
      importCards = null;
      importPicker.clear();
      await render();
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Bulk photos for existing cards ----
  const bulkPicker = photoPicker('bulk', () => renderBulkPreview());
  function bulkMatch() {
    return bulkPicker.get().map((f) => {
      const st = stemOf(f.name);
      const card = LAST.find((p) => (p.photo_files || []).includes(st)) || LAST.find((p) => p.id.toLowerCase() === st);
      return { file: f, card };
    });
  }
  function renderBulkPreview() {
    const rows = bulkMatch();
    const box = $('#bulk-preview');
    if (!rows.length) { box.innerHTML = ''; return; }
    const matched = rows.filter((r) => r.card);
    const cards = new Set(matched.map((r) => r.card.id));
    box.innerHTML = `<p><strong>${rows.length} photo(s) selected</strong> · <span class="good">${matched.length} matched to ${cards.size} card(s)</span> · <span class="${rows.length - matched.length ? 'bad' : ''}">${rows.length - matched.length} unmatched (will be skipped)</span></p>` +
      '<table><tbody>' + rows.map((r) => `<tr><td>${esc(r.file.name)}</td><td class="${r.card ? 'good' : 'bad'}">${r.card ? '→ ' + esc(r.card.title) : 'no matching card'}</td></tr>`).join('') + '</tbody></table>';
  }
  $('#bulk-btn').addEventListener('click', async () => {
    const rows = bulkMatch();
    result('bulk', '');
    if (!rows.length) return result('bulk', 'Choose or drop some photos first.');
    const send = rows.filter((r) => r.card).map((r) => r.file);
    if (!send.length) return result('bulk', 'None of these photos match a card. Name them after the photo names in your JSON, or after the card ID.');
    $('#bulk-btn').disabled = true;
    try {
      const rep = photoReport(await sendPhotosInBatches('bulk', send));
      const skipped = rows.filter((r) => !r.card).map((r) => r.file.name);
      result('bulk', rep.text + (skipped.length ? `\nSkipped (no matching card): ${skipped.join(', ')}` : ''), rep.ok);
      bulkPicker.clear();
      await render();
    } finally {
      $('#bulk-btn').disabled = false;
    }
  });

  if (token) showPanel().catch(showLogin);
})();
