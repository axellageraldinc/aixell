// After a hit from the sidebar's content search is opened, scroll to the message that matched and highlight the words.
import { state, on } from './state.js';

const TRIES = 40; // x 150 ms: the thread loads asynchronously after the chat opens
let timer = 0;

function markWords(root, words) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.meta, mark, button, summary') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const lower = node.nodeValue.toLowerCase();
    const found = words.map((w) => [lower.indexOf(w), w.length]).filter(([i]) => i !== -1).sort((a, b) => a[0] - b[0])[0];
    if (!found) continue;
    const [at, len] = found;
    const rest = node.splitText(at);
    const after = rest.splitText(len);
    const mark = document.createElement('mark');
    mark.className = 'find-mark';
    rest.replaceWith(mark);
    mark.append(rest);
    if (after.nodeValue) nodes.push(after);
  }
}

function attempt(find) {
  const messages = [...document.querySelectorAll('#message-list .msg')];
  const hit = messages.find((m) => find.words.every((w) => m.textContent.toLowerCase().includes(w)));
  if (!hit) return false;
  markWords(hit, find.words);
  hit.classList.add('is-found');
  (hit.querySelector('mark.find-mark') ?? hit).scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => { hit.classList.remove('is-found'); hit.querySelectorAll('mark.find-mark').forEach((m) => m.replaceWith(...m.childNodes)); }, 6000);
  return true;
}

export function initFindInChat() {
  on('session:changed', () => {
    const find = state.findInChat;
    if (!find || find.id !== state.sessionId) return;
    clearInterval(timer);
    let tries = 0;
    timer = setInterval(() => {
      if (state.findInChat !== find || attempt(find) || ++tries >= TRIES) {
        clearInterval(timer);
        if (state.findInChat === find) state.findInChat = null;
      }
    }, 150);
  });
}
