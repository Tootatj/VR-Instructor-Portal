// Instructor login screen — Phase 6 (Devlog 2026-06-04 single-code model).
//
// Posts to /api/instructor/login; on success the server sets the
// vrip_instructor cookie and we redirect to / (dashboard).

const form       = document.getElementById('login-form');
const codeInput  = document.getElementById('code-input');
const nameInput  = document.getElementById('name-input');
const errorEl    = document.getElementById('login-error');
const submitBtn  = document.getElementById('login-btn');

const NAME_STORAGE_KEY = 'vrip.instructor.lastName';

restoreLastName();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await attemptLogin();
});

async function attemptLogin() {
  const code = codeInput.value.trim();
  const displayName = nameInput.value.trim();

  if (!code) {
    showError('Please enter your company code.');
    codeInput.focus();
    return;
  }

  setBusy(true);
  hideError();

  try {
    const res = await fetch('/api/instructor/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code, displayName }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showError('That code wasn\'t recognized. Double-check with your OneBonsai contact.');
      } else if (res.status === 400) {
        showError(body.error ?? 'Please check your code and try again.');
      } else {
        showError(`Login failed (server returned ${res.status}). Try again in a moment.`);
      }
      setBusy(false);
      codeInput.focus();
      codeInput.select();
      return;
    }

    // Remember the instructor's name for next time (purely cosmetic; the
    // company code is intentionally NOT remembered — typing it is a
    // useful authn refresh + accidental tenant-switch protection).
    if (displayName) {
      try { localStorage.setItem(NAME_STORAGE_KEY, displayName); } catch { /* private mode etc. */ }
    }

    // Cookie is set; dashboard fetches its tenant scope from
    // /api/instructor/me on boot. A simple navigation to / is the
    // cleanest hand-off (avoids dragging this page's JS state around).
    window.location.assign('/');
  } catch (err) {
    console.error('[VRIP login] network error', err);
    showError('Network error — is the server running?');
    setBusy(false);
  }
}

function restoreLastName() {
  try {
    const last = localStorage.getItem(NAME_STORAGE_KEY);
    if (last) nameInput.value = last;
  } catch { /* private mode etc. */ }
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function hideError() {
  errorEl.hidden = true;
  errorEl.textContent = '';
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  codeInput.disabled = busy;
  nameInput.disabled = busy;
  submitBtn.textContent = busy ? 'Signing in…' : 'Sign in';
}
