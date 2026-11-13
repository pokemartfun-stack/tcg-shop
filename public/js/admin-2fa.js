(function () {
  const $ = (s) => document.querySelector(s);
  const A = () => window.TCGAdmin;
  let lastCodes = [];

  function hideAllPanels() {
    ['#sec-setup', '#sec-codes', '#sec-off-form', '#sec-regen-form'].forEach((s) => {
      const el = $(s);
      if (el) el.hidden = true;
    });
  }

  function renderStatus(st) {
    const banner = $('#sec-reset-banner');
    if (banner) {
      banner.hidden = !st.resetNotice && !st.resetVarSet;
      if (st.resetVarSet) {
        banner.textContent = '2FA was reset; remove ADMIN_2FA_RESET from Render and set 2FA up again. 2FA cannot be turned on while that variable is still set.';
      } else if (st.resetNotice) {
        banner.textContent = '2FA was reset; remove ADMIN_2FA_RESET from Render and set 2FA up again.';
      }
    }
    const status = $('#sec-status');
    if (status) {
      if (st.enabled) {
        const n = st.backupCodesRemaining;
        const codes = n === 1 ? '1 backup code left' : n + ' backup codes left';
        status.textContent = 'Two-factor login is on. ' + codes + '.';
      } else {
        status.textContent = 'Two-factor login is off. The admin password alone is enough to sign in.';
      }
    }
    const onAct = $('#sec-on-actions');
    const offAct = $('#sec-off-actions');
    if (onAct) onAct.hidden = !st.enabled;
    if (offAct) offAct.hidden = st.enabled || st.resetVarSet;
  }

  async function loadSecurity() {
    if (!A() || !A().token()) return;
    try {
      const st = await A().api('GET', '/security');
      renderStatus(st);
    } catch (err) {
      A().msg(err.message);
    }
  }

  function showCodes(codes) {
    lastCodes = codes.slice();
    const list = $('#sec-code-list');
    if (list) {
      list.innerHTML = lastCodes.map((c) => '<code>' + A().esc(c) + '</code>').join('');
    }
    const box = $('#sec-codes');
    if (box) box.hidden = false;
    const setup = $('#sec-setup');
    if (setup) setup.hidden = true;
  }

  function codesText() {
    const when = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    return [
      'Po-ke Mart Fun admin backup codes',
      'Generated: ' + when + ' (UK time)',
      'Each code can be used once. Store these somewhere safe — not only on the phone that has the authenticator app.',
      '',
      ...lastCodes,
      '',
    ].join('\n');
  }

  document.addEventListener('admin:ready', () => {
    hideAllPanels();
    loadSecurity();
  });

  const onBtn = $('#sec-on-btn');
  if (onBtn) onBtn.addEventListener('click', async () => {
    hideAllPanels();
    try {
      const d = await A().api('POST', '/security/2fa/setup');
      const img = $('#sec-qr');
      if (img) img.src = d.qrDataUrl;
      const sec = $('#sec-secret');
      if (sec) sec.textContent = d.secret;
      const code = $('#sec-confirm-code');
      if (code) code.value = '';
      const offAct = $('#sec-off-actions');
      if (offAct) offAct.hidden = true;
      $('#sec-setup').hidden = false;
      if (code) code.focus();
    } catch (err) { A().msg(err.message); }
  });

  const setupCancel = $('#sec-setup-cancel');
  if (setupCancel) setupCancel.addEventListener('click', () => { hideAllPanels(); loadSecurity(); });

  const confirmForm = $('#sec-confirm-form');
  if (confirmForm) confirmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await A().api('POST', '/security/2fa/confirm', { code: $('#sec-confirm-code').value });
      A().msg('Two-factor login is on. Save the backup codes below.' + A().syncNote(d), true);
      showCodes(d.backupCodes || []);
      await loadSecurity();
    } catch (err) { A().msg(err.message); }
  });

  const copyBtn = $('#sec-copy-codes');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codesText());
      A().msg('Backup codes copied.', true);
    } catch {
      A().msg('Could not copy automatically. Select the codes and copy them yourself.');
    }
  });

  const dlBtn = $('#sec-download-codes');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    const blob = new Blob([codesText()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'poke-mart-fun-backup-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const codesDone = $('#sec-codes-done');
  if (codesDone) codesDone.addEventListener('click', () => {
    lastCodes = [];
    hideAllPanels();
  });

  const regenBtn = $('#sec-regen-btn');
  if (regenBtn) regenBtn.addEventListener('click', () => {
    hideAllPanels();
    const form = $('#sec-regen-form');
    form.hidden = false;
    const c = $('#sec-regen-code');
    if (c) { c.value = ''; c.focus(); }
  });
  const regenCancel = $('#sec-regen-cancel');
  if (regenCancel) regenCancel.addEventListener('click', hideAllPanels);
  const regenForm = $('#sec-regen-form');
  if (regenForm) regenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = await A().api('POST', '/security/2fa/backup-codes', { code: $('#sec-regen-code').value });
      A().msg('New backup codes are ready. Save them now — the old ones no longer work.' + A().syncNote(d), true);
      $('#sec-regen-form').hidden = true;
      showCodes(d.backupCodes || []);
      await loadSecurity();
    } catch (err) { A().msg(err.message); }
  });

  const offBtn = $('#sec-off-btn');
  if (offBtn) offBtn.addEventListener('click', () => {
    hideAllPanels();
    const form = $('#sec-off-form');
    form.hidden = false;
    ['#sec-off-pw', '#sec-off-code', '#sec-off-backup'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
    const pw = $('#sec-off-pw');
    if (pw) pw.focus();
  });
  const offCancel = $('#sec-off-cancel');
  if (offCancel) offCancel.addEventListener('click', hideAllPanels);
  const offForm = $('#sec-off-form');
  if (offForm) offForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#sec-off-pw').value;
    const code = $('#sec-off-code').value.trim();
    const backupCode = $('#sec-off-backup').value.trim();
    if (!code && !backupCode) return A().msg('Enter an authenticator code or a backup code');
    try {
      const body = { password };
      if (backupCode) body.backupCode = backupCode;
      else body.code = code;
      const d = await A().api('POST', '/security/2fa/disable', body);
      A().msg('Two-factor login is off.' + A().syncNote(d), true);
      hideAllPanels();
      await loadSecurity();
    } catch (err) { A().msg(err.message); }
  });
})();
