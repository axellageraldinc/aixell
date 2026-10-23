// Composer attachments: upload on add, chips with thumbnail/icon, name, size and per-file state.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { fmtBytes } from './format.js';
import { notify } from './ui.js';
import { t } from './i18n.js';

const MAX_FILES = 10;

export function typeLabel(file) {
  const name = file.name ?? '';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (file.kind === 'audio' || file.type?.startsWith?.('audio/') || file.file?.type?.startsWith('audio/')) return 'AUDIO';
  return (ext || 'FILE').slice(0, 5).toUpperCase();
}
const MAX_BYTES = 25 * 1024 * 1024;

export function createAttachments({ container, onChange }) {
  let items = []; // { localId, file, name, size, id, kind, status: 'uploading'|'transcribing'|'ready'|'error', error, previewUrl }
  let nextId = 1;

  const changed = () => {
    container.replaceChildren(...items.map(chip));
    container.hidden = items.length === 0;
    onChange();
  };

  async function upload(item) {
    item.status = 'uploading';
    changed();
    if (item.size > MAX_BYTES) {
      Object.assign(item, { status: 'error', error: t('attachments.error.tooLarge') });
      return changed();
    }
    try {
      const res = await api(`${agentPath(state.agent)}/uploads`, {
        method: 'POST',
        body: item.file,
        headers: {
          'X-Filename': encodeURIComponent(item.name),
          'Content-Type': item.file.type || 'application/octet-stream',
        },
      });
      Object.assign(item, { status: 'ready', id: res.id, kind: res.kind, name: res.name ?? item.name });
      // Audio goes to the agent as a transcript, so it is not ready until that exists.
      if (res.kind === 'audio') {
        item.status = 'transcribing';
        item.startedAt = Date.now();
        changed();
        // The wait is up to the provider (2 to 10 s), so show a running clock instead of a silent spinner.
        const clock = setInterval(changed, 1000);
        try { await api(`${agentPath(state.agent)}/uploads/${encodeURIComponent(res.id)}/transcribe`, { method: 'POST' }); } finally { clearInterval(clock); }
        item.status = 'ready';
      }
    } catch (err) {
      Object.assign(item, { status: 'error', error: err.message });
    }
    changed();
  }

  function remove(item) {
    if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
    items = items.filter((x) => x !== item);
    changed();
  }

  // Claude-style tray: a square thumbnail for images, a small card (name + type) for everything else. The remove button
  // sits on the corner; uploading dims the card and shows a spinner.
  function chip(item) {
    const isImage = Boolean(item.previewUrl);
    const status = item.status === 'transcribing' ? t('attachments.transcribing', { seconds: Math.max(0, Math.round((Date.now() - item.startedAt) / 1000)) }) : item.status === 'error' ? item.error : '';
    const remove_ = h('button', { type: 'button', className: 'att-x', 'aria-label': t('attachments.remove', { name: item.name }), 'data-testid': 'attachment-remove', onClick: () => remove(item) }, icon('x', 12));
    const busy = item.status === 'uploading' || item.status === 'transcribing';
    const overlay = busy ? h('span', { className: 'att-busy', 'aria-hidden': 'true' }, h('span', { className: 'loading loading-spinner loading-sm' })) : null;
    const retry = item.status === 'error' ? h('button', { type: 'button', className: 'att-retry', onClick: () => upload(item) }, t('common.retry')) : null;
    const body = isImage
      ? [h('img', { className: 'att-img', src: item.previewUrl, alt: item.name, title: item.name }), retry]
      : [
          h('span', { className: 'att-name chip-name', title: item.name }, item.name),
          h('span', { className: 'att-foot' }, h('span', { className: 'att-type' }, typeLabel(item)), item.size ? h('span', { className: 'att-size' }, fmtBytes(item.size)) : null),
          status ? h('span', { className: 'att-status' }, status) : null,
          retry,
        ];
    return h('li', { className: `att ${isImage ? 'att-image' : 'att-file'} is-${item.status}`, 'data-testid': 'attachment-chip', title: status || item.name }, ...body, overlay, remove_);
  }

  return {
    add(files) {
      for (const file of files) {
        if (items.length >= MAX_FILES) {
          notify(t('attachments.error.tooMany', { count: MAX_FILES }));
          break;
        }
        const item = {
          localId: nextId++,
          file,
          name: file.name || 'pasted-image.png',
          size: file.size,
          status: 'uploading',
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        };
        items.push(item);
        upload(item);
      }
    },
    ready: () => items.filter((i) => i.status === 'ready').map(({ id, name, kind }) => ({ id, name, kind })),
    // What a draft keeps: the files are already on the server, so only their identity is worth storing. An upload
    // that is still in flight is not in here — it is not usable yet.
    snapshot: () => items.filter((i) => i.status === 'ready').map(({ id, name, kind, size }) => ({ id, name, kind, size })),
    // Rebuilds the tray from a saved draft (a draft swap, or the page coming back).
    restore(list) {
      const same = list.length === items.length && list.every((saved, i) => items[i].id === saved.id);
      if (same) return;
      for (const item of items) if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      items = list.map((saved) => ({
        localId: nextId++,
        file: null,
        name: saved.name,
        size: saved.size,
        kind: saved.kind,
        id: saved.id,
        status: 'ready',
        // An image preview comes back from the upload route instead of a blob the page created.
        previewUrl: saved.kind === 'image' ? `/api/uploads/${encodeURIComponent(saved.id)}` : null,
      }));
      changed();
    },
    isUploading: () => items.some((i) => i.status === 'uploading' || i.status === 'transcribing'),
    hasFailed: () => items.some((i) => i.status === 'error'),
    count: () => items.length,
    clear() {
      for (const item of items) if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      items = [];
      changed();
    },
  };
}
