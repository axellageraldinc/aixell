// Agent switcher at the top of the sidebar: one button that opens a scrollable list of every agent.
import { h, $ } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { state, emit, saveLastAgent, saveBootAgent } from './state.js';
import { statusBlock } from './ui.js';
import { bindPopover, bindListNav } from './popover.js';
import { agentLabel } from './format.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';

const root = $('#agent-switcher');
const nameEl = $('#agent-name');
const dotEl = $('#agent-dot');
const listEl = $('#agent-list');
const popover = bindPopover(root, { onOpen: () => (listEl.querySelector('[aria-selected=true]') ?? listEl.querySelector('.agent-option'))?.focus() });

const labelOf = agentLabel;

export const currentAgent = () => state.agents.find((a) => a.name === state.agent) ?? null;

export function syncAgentStatus() {
  const agent = currentAgent();
  state.agentOffline = Boolean(agent && !agent.online);
  nameEl.textContent = agent ? labelOf(agent) : APP_NAME;
  dotEl.className = `dot ${agent ? (agent.online ? 'is-online' : 'is-offline') : ''}`;
  emit('agent:status');
}

export async function loadAgents() {
  listEl.replaceChildren(statusBlock({ kind: 'loading', text: t('agents.loading') }));
  try {
    state.agents = (await api('/api/agents')).agents;
    render();
  } catch (err) {
    listEl.replaceChildren(statusBlock({ kind: 'error', text: err.message, onRetry: loadAgents }));
  }
}

function render() {
  // A single agent needs no switcher.
  root.classList.toggle('is-single', state.agents.length <= 1);
  if (state.agents.length === 0) {
    listEl.replaceChildren(statusBlock({ kind: 'empty', text: t('agents.empty') }));
  } else {
    listEl.replaceChildren(...state.agents.map(option));
  }
  syncAgentStatus();
}

function option(agent) {
  const selected = agent.name === state.agent;
  return h(
    'button',
    {
      type: 'button',
      role: 'option',
      className: 'agent-option',
      tabindex: -1,
      'aria-selected': String(selected),
      'data-testid': 'agent-option',
      onClick: () => select(agent.name),
    },
    h('span', { className: `dot ${agent.online ? 'is-online' : 'is-offline'}`, 'aria-hidden': 'true' }),
    h('span', { className: 'ao-text' }, h('span', { className: 'ao-name' }, labelOf(agent)), h('span', { className: 'ao-model' }, agent.model ?? '—')),
    agent.online ? null : h('span', { className: 'ao-offline' }, 'offline'),
    selected ? icon('check') : null,
  );
}

function select(name) {
  if (name === state.agent) return popover.close();
  state.agent = name;
  saveLastAgent(name);
  saveBootAgent(name);
  render();
  popover.close();
  emit('agent:select', name);
}

// Last used agent, else the default one, else the first.
export function pickInitialAgent(preferred) {
  const names = state.agents.map((a) => a.name);
  const candidates = [preferred, ...state.agents.filter((a) => a.isDefault).map((a) => a.name), ...names];
  return candidates.find((name) => name && names.includes(name)) ?? null;
}

// Start-up guess, before the list is back: the last used agent, so its chats and models already load in parallel.
export function guessAgent(name) {
  if (!name) return;
  state.agent = name;
  emit('agent:select', name);
}

export function selectInitialAgent(preferred) {
  const picked = pickInitialAgent(preferred);
  const guessedRight = picked === state.agent; // everything for it is already loading
  state.agent = picked;
  if (picked && preferred !== picked) saveLastAgent(picked); // forget a name the list does not have
  render();
  if (picked && !guessedRight) emit('agent:select', picked);
}

bindListNav(listEl, '.agent-option');
