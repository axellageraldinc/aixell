// A text selection stays inside one message. On a phone a scroll that starts on the text is read as dragging the
// selection handle, and the highlight then runs through every message above or below. Once something is selected, the
// other messages stop being selectable (CSS: [data-selecting]), and a range that still got out is pulled back in.
import { $ } from './dom.js';

const list = $('#message-list');
let active = null;

const messageOf = (node) => (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('.msg') ?? null;

function release() {
  if (!active) return;
  active.classList.remove('is-selecting');
  delete list.dataset.selecting;
  active = null;
}

function pullBack(selection, message) {
  const edge = document.createRange();
  edge.selectNodeContents(message);
  const after = Boolean(message.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING);
  const [node, offset] = after ? [edge.endContainer, edge.endOffset] : [edge.startContainer, edge.startOffset];
  selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, node, offset);
}

export function initSelectGuard() {
  document.addEventListener('selectionchange', () => {
    const selection = getSelection();
    const message = selection && !selection.isCollapsed ? messageOf(selection.anchorNode) : null;
    if (!message || !list.contains(message)) return release();
    if (active !== message) {
      release();
      active = message;
      message.classList.add('is-selecting');
      list.dataset.selecting = '1';
    }
    if (selection.focusNode && !message.contains(selection.focusNode)) pullBack(selection, message);
  });
}
