// Clipboard copy with a short-lived "done" state on the trigger button.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Calls show(true|false) now and show(null) again after 1.5s so the caller can restore its label.
export async function copyWithFeedback(text, show) {
  show(await copyText(text));
  setTimeout(() => show(null), 1500);
}
