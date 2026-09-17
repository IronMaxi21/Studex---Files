/**
 * Ask AI: a conversation beside whatever page is open.
 *
 * One panel for the whole window, not one per page, so a question asked over a
 * note can be followed up after moving to the deck made from it. What the
 * model is shown of the page is decided when each message is sent — the page
 * open *then*, by id — and the server reads the text itself from what the
 * account owns. The client never pastes a document into the request.
 *
 * Each conversation is saved to the account as it goes, so the history view
 * (the clock in the header) can reopen an earlier one and carry it on, or
 * delete it. A new chat starts a new saved conversation on its first answer.
 */
import { el, icon, mount } from './dom.js';
import { api } from './api.js';
import { currentPanes, currentRoute, navigate } from './router.js';
import { state } from './store.js';
import { register as registerShortcut } from './shortcuts.js';

const FILE_ROUTES = new Set(['doc', 'pdf', 'deck', 'canvas']);
const MAX_MESSAGES = 60;

/** `{ role, content, context?, failed? }`, oldest first. */
let messages = [];
let panel = null;
let sending = false;
/** Text selected on the page when the panel was opened, until sent or dismissed. */
let selection = '';
let usePage = true;
/** The saved conversation this panel is carrying on, once the server has named it. */
let chatId = null;
/** True while the panel shows the list of earlier chats instead of the open one. */
let showingHistory = false;

/** The top-bar button. Every page's top bar carries one. */
/** Pages where the conversation is about something on screen, and so earns the words. */
function onWorkPage() {
  return currentPanes().every((r) => ['doc', 'canvas', 'pdf', 'deck'].includes(r.path[0]) || (r.path[0] === 'flashcards' && r.path[1]));
}

export function chatButton() {
  const words = onWorkPage();
  return el('button', {
    class: 'chip ai-chat-open',
    type: 'button',
    title: 'Ask AI (⌘J)',
    'aria-label': 'Ask AI',
    'aria-expanded': panel ? 'true' : 'false',
    // Mousedown, not click: by the time a click lands the page's selection
    // has already been cleared by the press.
    onmousedown: () => captureSelection(),
    onclick: () => toggleChat(),
  }, icon('sparkle'), words ? 'Ask AI' : null);
}

function captureSelection() {
  const text = window.getSelection?.()?.toString().trim() ?? '';
  if (text && !panel?.contains(window.getSelection().anchorNode)) selection = text.slice(0, 6_000);
}

export function toggleChat() {
  if (panel) closeChat();
  else openChat();
}

export function openChat() {
  captureSelection();
  if (!panel) {
    panel = el('aside', { class: 'ai-chat', role: 'complementary', 'aria-label': 'Ask AI' });
    document.body.appendChild(panel);
    document.documentElement.classList.add('ai-chat-on');
  }
  syncButtons();
  void draw();
}

export function closeChat() {
  panel?.remove();
  panel = null;
  document.documentElement.classList.remove('ai-chat-on');
  syncButtons();
}

function syncButtons() {
  for (const button of document.querySelectorAll('.ai-chat-open')) {
    button.setAttribute('aria-expanded', panel ? 'true' : 'false');
    button.classList.toggle('on', Boolean(panel));
  }
}

/** What is open, as ids the server can read — and a name to show for it. */
function pageContext() {
  const route = currentRoute();
  const head = route.path[0] ?? 'home';
  const id = route.path[1];
  if (FILE_ROUTES.has(head) && id) {
    const file = state.files.find((f) => f.id === id);
    return { context: { route: head, fileId: id }, label: file ? `“${file.title || 'Untitled'}”` : 'this page' };
  }
  if (head === 'topics') return { context: { route: head }, label: 'your topics' };
  return null;
}

function suggestions(page) {
  const head = page?.context.route;
  if (head === 'doc' || head === 'pdf') return ['Summarise this in five bullet points', 'Explain the hardest idea here simply', 'Ask me three questions on this'];
  if (head === 'deck') return ['Which of these cards are too vague?', 'Suggest five more cards for this deck', 'Group these cards into themes'];
  if (head === 'topics') return ['What should I revise first?', 'Make me a week’s revision plan', 'Which topics look like they overlap?'];
  return ['Make me a revision timetable for this week', 'How does spaced repetition work?', 'Help me understand a topic step by step'];
}

async function draw() {
  if (!panel) return;
  const host = panel;

  let status;
  try { status = await api.aiStatus(); } catch { status = null; }
  if (panel !== host) return;

  const header = el('div', { class: 'ai-chat-head' },
    icon('sparkle', { size: 15 }),
    el('span', { class: 'title', text: 'Ask AI' }),
    el('span', { class: 'grow' }),
    el('button', {
      class: 'icon-btn' + (showingHistory ? ' on' : ''), type: 'button', title: 'Chat history', 'aria-label': 'Chat history',
      'aria-pressed': showingHistory ? 'true' : 'false',
      onclick: () => { showingHistory = !showingHistory; void draw(); },
    }, icon('clock-counter-clockwise')),
    messages.length || showingHistory
      ? el('button', { class: 'icon-btn', type: 'button', title: 'New chat', 'aria-label': 'New chat', onclick: () => newChat() }, icon('note-pencil'))
      : null,
    el('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => closeChat() }, icon('x')),
  );

  if (!status?.available) {
    mount(host, header, el('div', { class: 'ai-chat-empty' },
      el('p', { text: status ? 'No AI key is set, so there is nothing to answer with yet.' : 'Studex could not reach its server.' }),
      status
        ? el('button', { class: 'btn primary', type: 'button', text: 'Open Settings → AI', onclick: () => { closeChat(); navigate('settings/ai'); } })
        : null,
    ));
    return;
  }

  if (showingHistory) {
    mount(host, header, await historyList(host));
    return;
  }

  const page = pageContext();
  const log = el('div', { class: 'ai-chat-log', 'aria-live': 'polite' });
  const input = el('textarea', {
    class: 'input', rows: '1', placeholder: 'Ask anything…', 'aria-label': 'Message', maxlength: '8000',
  });
  const send = el('button', { class: 'btn primary ai-chat-send', type: 'button', title: 'Send (↩)', 'aria-label': 'Send' }, icon('paper-plane-right'));

  const submit = (textValue) => {
    const text = (textValue ?? input.value).trim();
    if (!text || sending) return;
    input.value = '';
    void ask(text);
  };
  send.onclick = () => submit();
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };

  if (!messages.length) {
    log.appendChild(el('div', { class: 'ai-chat-empty' },
      el('p', { text: page ? `Ask about ${page.label}, or anything else you are studying.` : 'Ask about anything you are studying.' }),
      el('div', { class: 'ai-chat-suggest' }, suggestions(page).map((s) =>
        el('button', { class: 'chip', type: 'button', text: s, onclick: () => submit(s) }))),
    ));
  }
  for (const message of messages) log.appendChild(bubble(message));
  if (sending) log.appendChild(el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Thinking…'));

  const attached = el('div', { class: 'ai-chat-attached' },
    page
      ? el('label', { class: 'ai-chat-tag', title: 'Send what is on this page with each question' },
          el('input', { type: 'checkbox', checked: usePage, onchange: (e) => { usePage = e.target.checked; } }),
          `Use ${page.label}`)
      : null,
    selection
      ? el('span', { class: 'ai-chat-tag', title: selection.slice(0, 400) },
          icon('text-aa', { size: 12 }), 'Selection attached',
          el('button', { type: 'button', 'aria-label': 'Remove the selection', onclick: () => { selection = ''; void draw(); } }, icon('x', { size: 11 })))
      : null,
  );

  mount(host,
    header,
    log,
    el('div', { class: 'ai-chat-compose' },
      attached.childNodes.length ? attached : null,
      el('div', { class: 'ai-chat-row' }, input, send),
      el('div', { class: 'ai-chat-foot', text: status.usage ? `${status.usage.remaining} of ${status.usage.limit} requests left this month · answers can be wrong` : 'Answers can be wrong' }),
    ),
  );
  log.scrollTop = log.scrollHeight;
  if (!sending) input.focus();
}

function newChat() {
  messages = [];
  chatId = null;
  showingHistory = false;
  void draw();
}

function when(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Earlier conversations, newest first: open one to carry it on, or delete it. */
async function historyList(host) {
  const box = el('div', { class: 'ai-chat-log ai-chat-history' });
  let chats;
  try { chats = (await api.aiChats()).chats; } catch (err) {
    box.appendChild(el('div', { class: 'ai-chat-empty' }, el('p', { text: err?.message ?? 'Could not load your chats.' })));
    return box;
  }
  if (panel !== host) return box;
  if (!chats.length) {
    box.appendChild(el('div', { class: 'ai-chat-empty' }, el('p', { text: 'No saved chats yet. Conversations are kept here as you have them.' })));
    return box;
  }
  const open = async (id) => {
    try {
      const { chat } = await api.aiChatGet(id);
      messages = chat.messages.map(({ role, content, context }) => ({ role, content, context: context ?? null }));
      chatId = chat.id;
      showingHistory = false;
    } catch { /* deleted elsewhere: the list redraws without it */ }
    void draw();
  };
  const list = el('ul', { class: 'ai-history-list' }, chats.map((c) => el('li', { class: 'ai-history-item' + (c.id === chatId ? ' on' : '') },
    el('button', { class: 'ai-history-open', type: 'button', onclick: () => open(c.id) },
      el('span', { class: 't', text: c.title || 'Untitled' }),
      el('span', { class: 'm', text: `${when(c.updated_at)} · ${c.turns} messages` })),
    el('button', {
      class: 'icon-btn', type: 'button', title: 'Delete chat', 'aria-label': `Delete “${c.title || 'Untitled'}”`,
      onclick: async () => {
        try { await api.aiChatDelete(c.id); } catch { /* already gone */ }
        if (c.id === chatId) { chatId = null; messages = []; }
        void draw();
      },
    }, icon('trash', { size: 13 })),
  )));
  box.append(list, el('button', {
    class: 'btn ai-history-clear', type: 'button', text: 'Delete all chats',
    onclick: async () => {
      if (!window.confirm('Delete every saved chat? This cannot be undone.')) return;
      try { await api.aiChatsClear(); } catch { /* shown by the redraw */ }
      chatId = null; messages = [];
      void draw();
    },
  }));
  return box;
}

function bubble(message) {
  if (message.role === 'user') {
    return el('div', { class: 'ai-msg user' }, el('div', { class: 'body', text: message.content }));
  }
  return el('div', { class: 'ai-msg assistant' + (message.failed ? ' failed' : '') },
    el('div', { class: 'body' }, message.failed ? message.content : markdown(message.content)),
    message.context ? el('div', { class: 'meta', text: `Read ${message.context}` }) : null,
    message.failed
      ? el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => retry() })
      : el('button', {
          class: 'icon-btn copy', type: 'button', title: 'Copy', 'aria-label': 'Copy the answer',
          onclick: () => navigator.clipboard?.writeText(message.content),
        }, icon('copy', { size: 13 })),
  );
}

/**
 * Opens the panel and asks straight away — for the "Ask AI" buttons placed
 * beside the things a question is usually about (a card you just got wrong,
 * a week of revision to plan). `usePage` says whether the open page goes too.
 */
export function askAbout(text, { withPage = true } = {}) {
  usePage = withPage;
  openChat();
  if (!sending) void ask(text);
}

async function ask(text) {
  messages.push({ role: 'user', content: text });
  await request();
}

async function retry() {
  if (messages[messages.length - 1]?.failed) messages.pop();
  await request();
}

async function request() {
  const page = pageContext();
  const context = {
    ...(usePage && page ? page.context : {}),
    ...(selection ? { selection } : {}),
  };
  selection = '';
  sending = true;
  void draw();

  const turns = messages.filter((m) => !m.failed).slice(-MAX_MESSAGES).map(({ role, content }) => ({ role, content }));
  // The server wants the conversation to start with a question.
  while (turns[0]?.role === 'assistant') turns.shift();

  try {
    const res = await api.aiChat({ messages: turns, context: Object.keys(context).length ? context : null, chatId });
    if (res.chatId) chatId = res.chatId;
    messages.push({ role: 'assistant', content: res.answer, context: res.context });
  } catch (err) {
    messages.push({ role: 'assistant', content: err?.message ?? 'The model did not answer.', failed: true });
  } finally {
    sending = false;
    void draw();
  }
}

/* ── a small, safe Markdown ───────────────────────────────────────────── */

/**
 * The subset the model is asked to write: paragraphs, lists, headings, code,
 * bold, italic and inline code. Built as nodes, never as HTML, so an answer
 * that contains markup shows the markup rather than running it.
 */
function markdown(source) {
  const out = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(el('pre', null, el('code', { text: code.join('\n') })));
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) { out.push(el('p', { class: 'h' }, inline(heading[1]))); i += 1; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        list.appendChild(el('li', null, inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))));
        i += 1;
      }
      out.push(list);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    out.push(el('p', null, inline(para.join('\n'))));
  }
  return out;
}

function inline(text) {
  const parts = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) parts.push(el('code', { text: token.slice(1, -1) }));
    else if (token.startsWith('**')) parts.push(el('strong', { text: token.slice(2, -2) }));
    else parts.push(el('em', { text: token.slice(1, -1) }));
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

registerShortcut({ id: 'ai-chat', keys: 'mod+j', group: 'General', label: 'Open or close the AI tutor', when: () => Boolean(state.user), run: () => toggleChat() });

document.addEventListener('keydown', (event) => {
  if (!state.user) return;
  if (event.key === 'Escape' && panel && panel.contains(document.activeElement)) closeChat();
});
