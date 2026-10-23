// One row of the session list: title, hover "more" menu, inline rename.
import { h } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { copyText } from './clipboard.js';
import { notify } from './ui.js';
import { exportMarkdown, printChat } from './export.js';
import { provisionalTitle, visibleTitle } from './auto-title.js';
import { t } from './i18n.js';

export const sessionTitle = (s) => s.title || provisionalTitle(s.id) || s.preview || t('sessions.untitled');
// What the title shows right now: a new chat's title is typed out, so this can be the first few letters of it.
export const displayTitle = (s) => visibleTitle(s, sessionTitle(s));

// handlers: { onOpen(session), onRename(session, title), onDelete(session) }
export function sessionRow(s, current, { onOpen, onRename, onDelete }) {
  const shown = displayTitle(s);
  const open = h(
    'button',
    { type: 'button', className: 'session-open', 'aria-current': current ? 'true' : null, title: sessionTitle(s) },
    h('span', { className: shown.typing ? 'session-title is-typing' : 'session-title' }, shown.text),
  );
  const row = h('div', { className: 'session-row', 'data-testid': 'session-row', 'data-id': s.id }, open);
  // The whole row opens the chat; the "more" button and the rename field are excluded.
  row.addEventListener('click', (event) => {
    if (!event.target.closest('.session-more, .rename-input')) onOpen(s);
  });
  if (s.source === 'telegram') return row;

  const more = h(
    'button',
    {
      type: 'button',
      className: 'ibtn ibtn-sm session-more',
      'aria-label': t('sessions.row.actions', { title: sessionTitle(s) }),
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () =>
        openMenu(more, [
          { label: t('sessions.row.copyId'), icon: 'copy', action: async () => notify((await copyText(s.id)) ? t('sessions.row.copyId.done') : t('common.copyFailed')) },
          { label: t('feed.export'), icon: 'download', testid: 'export-md', action: () => exportMarkdown(s) },
          { label: t('sessions.row.print'), icon: 'printer', testid: 'export-pdf', action: () => printChat(s) },
          { label: t('sessions.row.rename'), icon: 'pencil', action: () => startRename(row, open, s, onRename) },
          { label: t('common.delete'), icon: 'trash', destructive: true, confirm: { prompt: t('sessions.row.deleteConfirm'), label: t('common.delete') }, action: () => onDelete(s) },
        ]),
    },
    icon('more-horizontal'),
  );
  row.append(more);
  return row;
}

function startRename(row, open, s, onRename) {
  const title = sessionTitle(s);
  const input = h('input', { type: 'text', className: 'input input-sm rename-input', value: title, maxlength: 200, 'aria-label': t('sessions.row.titlePlaceholder') });
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    row.classList.remove('is-editing');
    input.replaceWith(open);
    if (save && next && next !== title) onRename(s, next);
    else open.focus();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  row.classList.add('is-editing');
  open.replaceWith(input);
  input.focus();
  input.select();
}
