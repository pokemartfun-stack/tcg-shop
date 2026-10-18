(function () {
  const $ = (s) => document.querySelector(s);
  let token = sessionStorage.getItem('adminToken') || '';

  function msg(text, ok) {
    const el = $('#msg');
    el.textContent = text || '';
    el.className = ok ? 'ok' : 'err';
  }

  async function api(method, url, body) {
    const res = await fetch('/api/admin' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) showLogin();
    if (!res.ok) throw new Error(data.error || 'Request failed');
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
        <td><img src="${esc(p.image)}" alt="" /></td>
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

  $('#rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'del') {
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
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.price_gbp = Number(body.price_gbp);
    body.stock = Number(body.stock);
    try {
      const d = await api('POST', '/products', body);
      msg('Added ' + d.product.id + syncNote(d), true);
      e.target.reset();
      await render();
    } catch (err) { msg(err.message); }
  });

  $('#upload-btn').addEventListener('click', async () => {
    const f = $('#json-file').files[0];
    if (!f) return msg('Choose a .json file first');
    const mode = document.querySelector('input[name=mode]:checked').value;
    let products;
    try { products = JSON.parse(await f.text()); } catch { return msg('That file is not valid JSON'); }
    if (mode === 'replace' && !confirm('Replace ALL cards with the ' + (products.length || 0) + ' in this file?')) return;
    try {
      const d = await api('POST', '/upload', { mode, products });
      msg(`Upload done (${d.mode}): ${d.added} added, ${d.updated} updated, ${d.total} total` + syncNote(d), true);
      $('#json-file').value = '';
      await render();
    } catch (err) { msg(err.message); }
  });

  if (token) showPanel().catch(showLogin);
})();
