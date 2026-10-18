(function () {
const { api, formatGbp } = window.TCG;

async function refreshCartBadge() {
  try {
    const cart = await api('/api/cart');
    const el = document.querySelectorAll('[data-cart-count]');
    el.forEach((node) => {
      node.textContent = String(cart.count || 0);
      node.hidden = !cart.count;
    });
  } catch {
    /* ignore */
  }
}

async function refreshAuthUI() {
  try {
    const { user } = await api('/api/auth/me');
    const guest = document.querySelectorAll('[data-auth-guest]');
    const signed = document.querySelectorAll('[data-auth-user]');
    const nameEls = document.querySelectorAll('[data-user-name]');
    if (user) {
      guest.forEach((n) => (n.hidden = true));
      signed.forEach((n) => (n.hidden = false));
      nameEls.forEach((n) => (n.textContent = user.name || user.email));
    } else {
      guest.forEach((n) => (n.hidden = false));
      signed.forEach((n) => (n.hidden = true));
    }
  } catch {
    /* ignore */
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

function wireAuthModal() {
  const backdrop = document.getElementById('auth-modal');
  if (!backdrop) return;

  document.querySelectorAll('[data-open-auth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-open-auth') || 'login';
      setAuthTab(tab);
      openModal('auth-modal');
    });
  });
  document.querySelectorAll('[data-close-auth]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal('auth-modal'));
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal('auth-modal');
  });

  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setAuthTab(btn.getAttribute('data-auth-tab')));
  });

  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('login-error');
      err.textContent = '';
      const fd = new FormData(loginForm);
      try {
        await api('/api/auth/login', {
          method: 'POST',
          body: { email: fd.get('email'), password: fd.get('password') },
        });
        closeModal('auth-modal');
        await refreshAuthUI();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('register-error');
      err.textContent = '';
      const fd = new FormData(registerForm);
      try {
        await api('/api/auth/register', {
          method: 'POST',
          body: {
            name: fd.get('name'),
            email: fd.get('email'),
            password: fd.get('password'),
          },
        });
        closeModal('auth-modal');
        await refreshAuthUI();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }

  document.querySelectorAll('[data-logout]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      await refreshAuthUI();
    });
  });
}

function setAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-auth-tab') === tab);
  });
  const login = document.getElementById('login-panel');
  const reg = document.getElementById('register-panel');
  if (login) login.hidden = tab !== 'login';
  if (reg) reg.hidden = tab !== 'register';
}

function authModalHtml() {
  return `
  <div class="modal-backdrop" id="auth-modal" aria-hidden="true">
    <div class="modal" role="dialog" aria-labelledby="auth-title">
      <h2 id="auth-title">Account</h2>
      <p class="hint">Optional — you can also checkout as a guest.</p>
      <div class="tabs">
        <button type="button" class="active" data-auth-tab="login">Log in</button>
        <button type="button" data-auth-tab="register">Register</button>
      </div>
      <div id="login-panel">
        <form id="login-form">
          <div class="form-row"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
          <div class="form-row"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
          <p class="error" id="login-error"></p>
          <div class="modal-actions">
            <button type="button" class="btn secondary" data-close-auth>Cancel</button>
            <button type="submit" class="btn">Log in</button>
          </div>
        </form>
      </div>
      <div id="register-panel" hidden>
        <form id="register-form">
          <div class="form-row"><label>Name</label><input name="name" type="text" autocomplete="name"></div>
          <div class="form-row"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
          <div class="form-row"><label>Password (min 8 characters)</label><input name="password" type="password" required minlength="8" autocomplete="new-password"></div>
          <p class="error" id="register-error"></p>
          <div class="modal-actions">
            <button type="button" class="btn secondary" data-close-auth>Cancel</button>
            <button type="submit" class="btn">Create account</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
}

function ensureAuthModal() {
  if (!document.getElementById('auth-modal')) {
    document.body.insertAdjacentHTML('beforeend', authModalHtml());
  }
  wireAuthModal();
}

document.addEventListener('DOMContentLoaded', async () => {
  ensureAuthModal();
  await Promise.all([refreshCartBadge(), refreshAuthUI()]);
});

window.TCGApp = { refreshCartBadge, refreshAuthUI, openModal, closeModal };
})();
