/**
 * Ask AI: a conversation beside whatever page is open.
 *
 * One panel for the whole window, not one per page, so a question asked over a
 * note can be followed up after moving to the deck made from it. What the
 * model is shown of the page is decided when each message is sent — the page
 * open *then*, by id — and the server reads the text itself from what the
 * account owns wherever it can, so a note or a deck goes over as an id.
 *
 * What it cannot fetch — a PDF's page, the calendar, statistics, a canvas — it
 * is sent, as the text the pane is showing. That is the difference between a
 * model that can read the screen and one that can only read the library.
 *
 * Each conversation is saved to the account as it goes, so the history view
 * (the clock in the header) can reopen an earlier one and carry it on, or
 * delete it. A new chat starts a new saved conversation on its first answer.
 */
import { el, icon, mount } from './dom.js';
import { api } from './api.js';
import { currentPanes, currentRoute, navigate } from './router.js';
import { state, fileById, toast } from './store.js';
import { carriesItem, readItem } from './dnd.js';
import { FILE_ICON } from './format.js';
import { sfx } from './sfx.js';
import { register as registerShortcut } from './shortcuts.js';
import { hasMath, mathSegments, renderMath } from './math.js';
import { highlight, resolveLanguage, guessLanguage } from './syntax.js';
import { actionCard } from './ai-actions.js';
import { screenText } from './screen.js';

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
/**
 * A file dragged onto the panel from the library, as `{ id, title, kind }`.
 *
 * It answers the commonest way of wanting to ask about something that is not
 * open: you can see it in the sidebar, so you throw it at the chat rather than
 * opening it in a pane first and losing the page you were on. While one is
 * attached it is what the question is about — it stands in for the page, since
 * the server reads one file per question.
 */
let pinned = null;

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
    acceptFiles(panel);
    document.body.appendChild(panel);
    document.documentElement.classList.add('ai-chat-on');
  }
  syncButtons();
  void draw();
}

/**
 * The whole panel is the target, not a strip at the bottom of it: a drag is
 * aimed with the shoulder, and the thing being aimed at is the chat.
 */
function acceptFiles(node) {
  node.addEventListener('dragover', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    node.classList.add('drop-on');
  });
  // A drag that leaves for a child fires leave on the parent first, so the
  // highlight is cleared only when the pointer is genuinely outside.
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('drop-on');
  });
  node.addEventListener('drop', (event) => {
    node.classList.remove('drop-on');
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = readItem(event);
    const files = (item?.items ?? (item ? [item] : [])).filter((one) => one.kind === 'file');
    if (!files.length) { toast('Folders cannot be attached — drop a file.'); return; }
    attach(files[0].id);
    // One question reads one file, so the rest are not silently dropped on the
    // floor without saying so.
    if (files.length > 1) toast('One file at a time — attached the first.');
  });
}

/** Attach a file by id, if it is still in the library. */
function attach(id) {
  const file = fileById(id);
  if (!file) { toast('That file is no longer there.'); return; }
  pinned = { id: file.id, title: file.title || 'Untitled', kind: file.kind };
  sfx('drop');
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
  // Everything else: there is no row to fetch, but there is a screen to read,
  // so the page is still something the question can be asked about.
  return { context: { route: head }, label: ROUTE_LABELS[head] ?? 'this page' };
}

/** What each screen is called when the chat offers to read it. */
const ROUTE_LABELS = {
  home: 'your home page',
  library: 'your library',
  folder: 'this folder',
  calendar: 'your calendar',
  timetable: 'your timetable',
  canvas: 'this canvas',
  flashcards: 'your review queue',
  review: 'this review',
  test: 'this test',
  mock: 'this mock',
  stats: 'your statistics',
  trash: 'the trash',
  settings: 'settings',
};

function suggestions(page) {
  // An attached file is what the chips should be about, since it is what the
  // question will be read against.
  const head = pinned?.kind ?? page?.context.route;
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
      el('p', { text: pinned
        ? `Ask about “${pinned.title}”, or anything else you are studying.`
        : page ? `Ask about ${page.label}, or anything else you are studying.` : 'Ask about anything you are studying.' }),
      el('p', { class: 'muted', text: 'Drag a file here to ask about it.' }),
      el('div', { class: 'ai-chat-suggest' }, suggestions(page).map((s) =>
        el('button', { class: 'chip', type: 'button', text: s, onclick: () => submit(s) }))),
    ));
  }
  for (const message of messages) log.appendChild(bubble(message));
  if (sending) log.appendChild(el('div', { class: 'ai-thinking' }, icon('sparkle', { size: 13 }), 'Thinking…'));

  const attached = el('div', { class: 'ai-chat-attached' },
    pinned
      ? el('span', { class: 'ai-chat-tag file', title: `Answering about “${pinned.title}”` },
          icon(FILE_ICON[pinned.kind] ?? 'file', { size: 12 }), pinned.title,
          el('button', { type: 'button', 'aria-label': `Detach ${pinned.title}`, onclick: () => { pinned = null; void draw(); } }, icon('x', { size: 11 })))
      : null,
    page
      ? el('label', { class: 'ai-chat-tag', title: 'Send what is on this page with each question' },
          el('input', { type: 'checkbox', checked: usePage, onchange: (e) => { usePage = e.target.checked; } }),
          // With a file attached the page is no longer what the question is
          // about, so the box offers the smaller thing it can still do.
          pinned ? 'Also read this page' : `Use ${page.label}`)
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
  pinned = null;
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
  // The screen is read at the moment of asking, not when the panel was drawn:
  // a question typed after scrolling is about where the reader ended up.
  const screen = usePage ? screenText() : '';
  const context = {
    ...(usePage && page ? page.context : {}),
    // A file dropped on the panel wins over the page behind it: one question
    // reads one file, and the attached one is the one that was chosen.
    ...(pinned ? { route: pinned.kind, fileId: pinned.id } : {}),
    ...(screen ? { screen } : {}),
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
/**
 * `Question :: Answer`, which is how the tutor is asked to write a card and
 * how the app's own editors store one. The split is on the first ` :: ` with
 * text either side, so a card whose answer contains a colon survives.
 */
const CARD_LINE = /^\s*(?:[-*\u2022]\s+)?(.+?)\s+::\s+(.+?)\s*$/;

/**
 * A run of card lines, one row each, with a button that makes the deck.
 *
 * The rows are drawn rather than the raw lines so a set of twenty cards reads
 * as twenty cards; the button hands the same rows to the deck action, so
 * pressing it goes through exactly the path a proposed deck goes through.
 */
function cardList(rows, heading) {
  const wrap = el('div', { class: 'ai-cards' });
  for (const row of rows) {
    wrap.appendChild(el('div', { class: 'ai-card' },
      el('span', { class: 'q' }, inline(row.front)),
      el('span', { class: 'a' }, inline(row.back)),
    ));
  }
  if (rows.length > 1) {
    wrap.appendChild(actionCard(JSON.stringify({
      do: 'deck',
      title: heading ? heading.slice(0, 80) : 'Flashcards',
      cards: rows,
    })));
  }
  return wrap;
}

function markdown(source) {
  const out = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // The heading a run of cards sits under names the deck it would become.
  let lastHeading = '';
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      // A block the tutor marked as something it is offering to make becomes a
      // card with a button on it rather than a wall of JSON. Anything the card
      // does not recognise comes back as the code it is, so a malformed offer
      // is visible instead of silently dropped.
      const body = code.join('\n');
      out.push(fence[1] === 'studex-action'
        ? actionCard(body)
        : el('pre', { class: 'chat-code' },
            el('code', null, highlight(body, resolveLanguage(fence[1]) ?? guessLanguage(body) ?? 'plain'))));
      continue;
    }
    // A display equation standing on its own. It is pulled out at block level
    // rather than left to `inline`, because the model writes anything with a
    // fraction in it as `$$` on one line, the equation on the next and `$$` on
    // a third — three paragraphs, as far as the rest of this parser is
    // concerned. A run that never closes is left alone and falls through to the
    // paragraph below, so a stray `$$` costs a line rather than the answer.
    const opener = /^\s*(\$\$|\\\[)\s*/.exec(line);
    if (opener) {
      const close = opener[1] === '$$' ? '$$' : '\\]';
      const body = [];
      let at = i;
      let rest = line.slice(opener[0].length);
      let shut = rest.indexOf(close);
      while (shut === -1 && at + 1 < lines.length) {
        body.push(rest);
        at += 1;
        rest = lines[at];
        shut = rest.indexOf(close);
      }
      // Only a block if the delimiter closes the line it is on; `$$x$$ and so`
      // is a sentence with an equation in it, and `inline` renders that better.
      if (shut !== -1 && !rest.slice(shut + close.length).trim()) {
        body.push(rest.slice(0, shut));
        const latex = body.join('\n');
        i = at + 1;
        if (latex.trim()) { out.push(mathNode(latex, true)); continue; }
      }
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      lastHeading = heading[1].trim();
      out.push(el('p', { class: 'h' }, inline(heading[1])));
      i += 1;
      continue;
    }
    // A run of `Question :: Answer` lines is a set of cards, not a paragraph.
    // Left to the paragraph branch below they are joined with spaces and drawn
    // as one block of prose — every card in the set run together on one line,
    // which is exactly what a student does not want to read. Each line becomes
    // its own row here, and the run as a whole gets a button that turns it
    // into a real deck.
    if (CARD_LINE.test(line)) {
      const rows = [];
      while (i < lines.length && CARD_LINE.test(lines[i])) {
        const card = CARD_LINE.exec(lines[i]);
        rows.push({ front: card[1].trim(), back: card[2].trim() });
        i += 1;
      }
      out.push(cardList(rows, lastHeading));
      continue;
    }
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
    while (i < lines.length && lines[i].trim() && !CARD_LINE.test(lines[i])
      && !/^\s*(```|#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i])) { para.push(lines[i]); i += 1; }
    out.push(el('p', null, inline(para.join('\n'))));
  }
  return out;
}

/**
 * One equation, typeset.
 *
 * The model is asked for LaTeX and used to hand back `$2\\text{H}^+ \\rightarrow
 * \\text{H}_2$` as literal characters, which is the raw source of the thing the
 * student asked to see. KaTeX is already vendored for documents and cards, so
 * the same renderer draws it here; it loads itself on first use and shows the
 * source until it arrives.
 */
function mathNode(latex, display) {
  const node = el(display ? 'div' : 'span', { class: display ? 'ai-math' : 'math-inline' });
  renderMath(node, latex, { display });
  return node;
}

/**
 * Inline formatting, with maths taken out first.
 *
 * Order matters: `$a * b * c$` run through the emphasis pass first comes back
 * with the middle turned into italics and the asterisks eaten, so the LaTeX is
 * lifted out before a single markdown rule is applied, and only the prose
 * between equations is marked up.
 */
function inline(text) {
  if (!hasMath(text)) return inlineMarkdown(text);
  const parts = [];
  for (const seg of mathSegments(text)) {
    if (seg.type === 'text') parts.push(...inlineMarkdown(seg.value));
    else parts.push(mathNode(seg.value, seg.type === 'display'));
  }
  return parts;
}

function inlineMarkdown(text) {
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
