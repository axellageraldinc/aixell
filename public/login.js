// Sign-in page: post credentials to /api/login, show errors and a countdown on 429.
import { $ } from './lib/dom.js';
import { fetchRaw, toApiError } from './lib/api.js';
import { t } from './lib/i18n.js';

const form = $('#login-form');
const errorEl = $('#login-error');
const submitBtn = $('#login-submit');
let timer = 0;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

const waitMessage = (seconds) => t('login.error.rateLimited', { seconds });

function startCooldown(seconds) {
  clearInterval(timer);
  let left = Math.max(1, Math.ceil(seconds));
  submitBtn.disabled = true;
  showError(waitMessage(left));
  timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      errorEl.hidden = true;
      submitBtn.disabled = false;
      return;
    }
    showError(waitMessage(left));
  }, 1000);
}

async function onSubmit(event) {
  event.preventDefault();
  const data = new FormData(form);
  const body = {
    username: String(data.get('username') ?? '').trim(),
    password: String(data.get('password') ?? ''),
    code: String(data.get('code') ?? '').trim(),
  };
  errorEl.hidden = true;
  submitBtn.disabled = true;

  try {
    // 401 here means wrong credentials, not an expired session, so no redirect.
    const res = await fetchRaw('/api/login', { method: 'POST', body, redirectOn401: false });
    if (res.ok) {
      location.href = '/';
      return;
    }
    const err = await toApiError(res);
    if (err.status === 429 && err.retryAfter != null) {
      startCooldown(err.retryAfter);
      return;
    }
    showError(err.status === 401 ? t('login.error.invalid') : err.message);
  } catch (err) {
    showError(err.message);
  }
  submitBtn.disabled = false;
}

form.addEventListener('submit', onSubmit);
// Focus the first empty field.
[...form.querySelectorAll('input')].find((input) => !input.value)?.focus();
