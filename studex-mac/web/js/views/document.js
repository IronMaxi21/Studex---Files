/** Screen 07 — block document editor. */
import { el, icon, mount, applyColor, colorLabel } from '../dom.js';
import { dropdown } from '../select.js';
import { api } from '../api.js';
import { tagStrip, relatedPanel } from '../tags.js';
import { state, fileById, folderById, loadLibrary, loadTags, toast, reportError } from '../store.js';
import { navigate, openBeside } from '../router.js';
import { topbar, fileCrumbs, pageMenu, fileItems } from '../shell.js';
import { openMenu } from '../menu.js';
import { dialog, confirmDelete } from '../dialog.js';
import { renderInline, toggleMark, caretRange, setCaretRange, inlineClozes, clozeQuestion, stripMarks, HIGHLIGHTS } from '../inline.js';
import { plural, relative, FILE_ICON, FILE_LABEL } from '../format.js';
import { deckResolver, parseCard, openCard, syncCard, isCloze, clozeGroups, clozeFace } from '../cards-inline.js';
import { renderMath, loadKatex } from '../math.js';
import { canvasPreview } from '../canvas-preview.js';
import { aiAvailable, generateCards, quizDialog } from '../ai.js';
import { carriesItem, readItem, dragBlock } from '../dnd.js';
import { fileToBlocks, isImportableDocument } from '../import-doc.js';
import { openOcclusionEditor, readOcclusion } from '../occlusion.js';

/**
 * Everything `/` can put on the page.
 *
 * `keywords` are the other names a block goes by. The menu searches them as
 * well as the label, so `/h1`, `/todo` and `/yt` land where they should
 * without those words having to be printed on the row.
 */
const BLOCK_TYPES = [
  { type: 'paragraph', icon: 'text-align-left', label: 'Text', keywords: 'paragraph plain body p' },
  { type: 'heading', level: 1, icon: 'text-h-one', label: 'Heading 1', keywords: 'h1 title' },
  { type: 'heading', level: 2, icon: 'text-h-two', label: 'Heading 2', keywords: 'h2 subtitle' },
  { type: 'heading', level: 3, icon: 'text-h-three', label: 'Heading 3', keywords: 'h3' },
  { type: 'bullet', icon: 'list-bullets', label: 'Bulleted list', keywords: 'ul point dash outline' },
  { type: 'numbered', icon: 'list-numbers', label: 'Numbered list', keywords: 'ol ordered steps 1' },
  { type: 'todo', icon: 'check-square', label: 'To-do', keywords: 'task checkbox tick' },
  { type: 'table', icon: 'table', label: 'Table', keywords: 'grid rows columns spreadsheet' },
  { type: 'image', icon: 'image', label: 'Image', keywords: 'picture photo diagram screenshot occlusion' },
  { type: 'pdf', icon: 'file-pdf', label: 'Link a PDF', keywords: 'paper past exam spec' },
  { type: 'canvas', icon: 'graph', label: 'Diagram', keywords: 'canvas draw sketch mindmap' },
  { type: 'flashcard', icon: 'cards', label: 'Flashcard', keywords: 'card revision question answer' },
  { type: 'code', icon: 'code', label: 'Code', keywords: 'snippet monospace program' },
  { type: 'math', icon: 'function', label: 'Equation', keywords: 'latex formula katex maths' },
  { type: 'quote', icon: 'quotes', label: 'Quote', keywords: 'blockquote citation source' },
  { type: 'columns', icon: 'columns', label: 'Columns', keywords: 'side by side compare split' },
  { type: 'embed', icon: 'globe', label: 'Embed', keywords: 'youtube video vimeo desmos geogebra iframe yt' },
  { type: 'portal', icon: 'arrows-in', label: 'Portal to another page', keywords: 'transclude mirror include reference' },
  { type: 'template', icon: 'stack', label: 'Template', keywords: 'boilerplate reuse insert skeleton starter outline lecture brief' },
  { type: 'divider', icon: 'minus', label: 'Divider', keywords: 'rule line break hr separator' },
];

/**
 * The sites an embed may be framed from.
 *
 * A URL in a document is not permission to put an arbitrary page inside the
 * app: a framed site runs its own scripts next to the notes. These are the
 * ones a student actually embeds while revising, and anything else is drawn
 * as a link that opens outside instead.
 */
const EMBED_HOSTS = [
  'www.youtube.com', 'youtube.com', 'youtu.be', 'www.youtube-nocookie.com',
  'player.vimeo.com', 'vimeo.com',
  'www.desmos.com', 'desmos.com',
  'www.geogebra.org', 'geogebra.org',
  'docs.google.com', 'drive.google.com',
];

/**
 * An embeddable URL, or null when the host is not on the list.
 *
 * A watch link and an embed link are different URLs on the same site, so the
 * two shapes YouTube and Vimeo use are rewritten rather than refused — pasting
 * the address out of the browser bar is what people actually do.
 */
export function embedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (!EMBED_HOSTS.includes(url.hostname)) return null;

  if (url.hostname === 'youtu.be') {
    return `https://www.youtube-nocookie.com/embed/${url.pathname.slice(1)}`;
  }
  if (url.hostname.endsWith('youtube.com') && url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (url.hostname === 'vimeo.com') {
    return `https://player.vimeo.com/video/${url.pathname.slice(1)}`;
  }
  return url.href;
}

/**
 * Whether a table cell holds something that can be opened.
 *
 * Only `http`/`https`, because a cell is typed by hand and a link that can run
 * something — `javascript:` chief among them — is not a link, it is a trap.
 */
function isLink(value) {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

/**
 * Pages that get written again and again, written out once.
 *
 * A template here is a list of lines, not a stored document: the shapes below
 * go through `blankBlock` like any other line, so a template can never carry a
 * field a block of that type does not have, and adding a field to a block type
 * does not leave the templates behind. Anything more particular than these —
 * the way one teacher wants a practical written up, a course's own essay
 * frame — is a page of your own, and the picker offers those as well.
 */
const TEMPLATES = [
  {
    id: 'lecture',
    icon: 'note-pencil',
    label: 'Lecture notes',
    note: 'Date and topic at the top, the lesson in the middle, what to look up at the bottom.',
    lines: [
      { type: 'heading', level: 1, text: 'Lecture — {date}' },
      { type: 'paragraph', text: '**Topic:** ' },
      { type: 'heading', level: 2, text: 'Notes' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Terms' },
      { type: 'bullet', text: 'term :: meaning' },
      { type: 'heading', level: 2, text: 'Follow up' },
      { type: 'todo', text: '' },
    ],
  },
  {
    id: 'essay',
    icon: 'text-align-left',
    label: 'Essay plan',
    note: 'A line of argument, three points with evidence, and the counter-argument answered.',
    lines: [
      { type: 'heading', level: 1, text: 'Essay plan' },
      { type: 'quote', text: 'Paste the question here' },
      { type: 'heading', level: 2, text: 'Line of argument' },
      { type: 'paragraph', text: '' },
      { type: 'heading', level: 2, text: 'Point 1' },
      { type: 'bullet', text: 'Claim' },
      { type: 'bullet', text: 'Evidence', indent: 1 },
      { type: 'bullet', text: 'So what', indent: 1 },
      { type: 'heading', level: 2, text: 'Point 2' },
      { type: 'bullet', text: 'Claim' },
      { type: 'bullet', text: 'Evidence', indent: 1 },
      { type: 'bullet', text: 'So what', indent: 1 },
      { type: 'heading', level: 2, text: 'Point 3' },
      { type: 'bullet', text: 'Claim' },
      { type: 'bullet', text: 'Evidence', indent: 1 },
      { type: 'bullet', text: 'So what', indent: 1 },
      { type: 'heading', level: 2, text: 'Against' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Conclusion' },
      { type: 'paragraph', text: '' },
    ],
  },
  {
    id: 'paper',
    icon: 'exam',
    label: 'Past paper review',
    note: 'The marks you dropped, why you dropped them, and the one thing to do about it.',
    lines: [
      { type: 'heading', level: 1, text: 'Paper review — {date}' },
      { type: 'table', columns: ['Question', 'Marks', 'Got', 'Why it went'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
      { type: 'heading', level: 2, text: 'What I did not know' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'What I knew and lost anyway' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Next' },
      { type: 'todo', text: '' },
    ],
  },
  {
    id: 'topic',
    icon: 'cards',
    label: 'Topic summary',
    note: 'A topic written so that the facts in it are already cards.',
    lines: [
      { type: 'heading', level: 1, text: 'Topic' },
      { type: 'paragraph', text: '**Specification point:** ' },
      { type: 'heading', level: 2, text: 'The idea in a sentence' },
      { type: 'paragraph', text: '' },
      { type: 'heading', level: 2, text: 'Definitions' },
      { type: 'bullet', text: 'term :: meaning' },
      { type: 'heading', level: 2, text: 'Worth remembering' },
      { type: 'bullet', text: 'The {answer} goes in the braces.' },
      { type: 'heading', level: 2, text: 'Where it is asked about' },
      { type: 'bullet', text: '' },
    ],
  },
  {
    id: 'practical',
    icon: 'flask',
    label: 'Practical write-up',
    note: 'Method, results and the honest paragraph about what went wrong.',
    lines: [
      { type: 'heading', level: 1, text: 'Practical — {date}' },
      { type: 'paragraph', text: '**Aim:** ' },
      { type: 'heading', level: 2, text: 'Apparatus' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Method' },
      { type: 'numbered', text: '' },
      { type: 'heading', level: 2, text: 'Results' },
      { type: 'table', columns: ['Trial', 'Reading', 'Uncertainty'], rows: [['', '', ''], ['', '', ''], ['', '', '']] },
      { type: 'heading', level: 2, text: 'Analysis' },
      { type: 'paragraph', text: '' },
      { type: 'heading', level: 2, text: 'Evaluation' },
      { type: 'bullet', text: '' },
    ],
  },
  {
    id: 'brief',
    icon: 'blueprint',
    label: 'Project brief',
    note: 'What it is for, what counts as finished, and who is waiting on what.',
    lines: [
      { type: 'heading', level: 1, text: 'Project brief' },
      { type: 'paragraph', text: '**Owner:** ' },
      { type: 'paragraph', text: '**Due:** ' },
      { type: 'heading', level: 2, text: 'Why' },
      { type: 'paragraph', text: '' },
      { type: 'heading', level: 2, text: 'Done means' },
      { type: 'todo', text: '' },
      { type: 'heading', level: 2, text: 'Steps' },
      { type: 'table', columns: ['Step', 'Owner', 'By', 'Status'], rows: [['', '', '', ''], ['', '', '', '']], columnTypes: ['text', 'text', 'date', 'status'] },
      { type: 'heading', level: 2, text: 'Risks' },
      { type: 'bullet', text: '' },
    ],
  },
  {
    id: 'week',
    icon: 'calendar-check',
    label: 'Weekly review',
    note: 'A recurring task: what landed, what slipped, what next week is for.',
    lines: [
      { type: 'heading', level: 1, text: 'Week to {date}' },
      { type: 'heading', level: 2, text: 'Covered' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Shaky' },
      { type: 'bullet', text: '' },
      { type: 'heading', level: 2, text: 'Next week' },
      { type: 'todo', text: '' },
      { type: 'divider' },
      { type: 'paragraph', text: '' },
    ],
  },
];

/** Today, written the way a person writes it at the top of a page. */
function templateDate() {
  return new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * A template's lines turned into real blocks.
 *
 * Every line is built by `blankBlock` first and only then overwritten, so the
 * block that comes out has exactly the fields its type is supposed to have —
 * a template cannot invent one and cannot forget one.
 */
function templateBlocks(template) {
  return template.lines.map((line) => {
    const block = blankBlock(line);
    for (const [key, value] of Object.entries(line)) {
      if (key === 'type' || key === 'level') continue;
      block[key] = typeof value === 'string' ? value.replace('{date}', templateDate()) : JSON.parse(JSON.stringify(value));
    }
    return block;
  });
}

function blankBlock(spec) {
  const id = crypto.randomUUID();
  // Every line that can hold running text can hold a `{blank}`, and each blank
  // remembers the card it made. Declared up front so the field survives a
  // change of line type instead of being dropped and made again.
  const cloze = { clozeCardIds: [] };
  switch (spec.type) {
    case 'heading': return { id, type: 'heading', level: spec.level ?? 2, text: '', ...cloze };
    case 'bullet': return { id, type: 'bullet', text: '', indent: spec.indent ?? 0, collapsed: false, cardId: null, cdf: null, layout: 'list', ...cloze };
    case 'numbered': return { id, type: 'numbered', text: '', indent: spec.indent ?? 0, ...cloze };
    case 'todo': return { id, type: 'todo', text: '', done: false, due: null, ...cloze };
    case 'table': return { id, type: 'table', columns: ['Column', 'Column'], rows: [['', '']], rowLabels: null };
    case 'flashcard': return { id, type: 'flashcard', front: '', back: '', cardId: null };
    case 'code': return { id, type: 'code', language: null, text: '' };
    case 'math': return { id, type: 'math', latex: '', caption: null };
    case 'quote': return { id, type: 'quote', text: '', cite: null, ...cloze };
    case 'embed': return { id, type: 'embed', url: spec.url ?? '', caption: null };
    case 'portal': return { id, type: 'portal', fileId: spec.fileId ?? '', blockId: spec.blockId ?? null, caption: null };
    case 'columns': return {
      id, type: 'columns',
      columns: [{ title: '', lines: [''] }, { title: '', lines: [''] }],
    };
    case 'divider': return { id, type: 'divider' };
    default: return { id, type: 'paragraph', text: '', ...cloze };
  }
}

/**
 * Every open copy of a document, by file id.
 *
 * The same page in both halves of a split used to be two editors that each
 * believed they held the latest revision: whichever saved second hit a
 * conflict, reloaded, and threw away what had just been typed into it. Now a
 * save in one is handed straight to the others, so they move to the new
 * revision together and only a genuine collision — both edited at once — is
 * ever asked about.
 */
const openCopies = new Map();

function joinCopies(fileId, copy) {
  if (!openCopies.has(fileId)) openCopies.set(fileId, new Set());
  openCopies.get(fileId).add(copy);
  return () => {
    const set = openCopies.get(fileId);
    set?.delete(copy);
    if (set && !set.size) openCopies.delete(fileId);
  };
}

function tellCopies(fileId, from, saved) {
  for (const copy of openCopies.get(fileId) ?? []) if (copy !== from) copy.adopt(saved);
}

export async function documentView(route, host) {
  const fileId = route.path[1];
  if (!fileId) { navigate('library'); return; }

  const [{ document: doc }] = await Promise.all([api.document(fileId)]);
  const file = fileById(fileId) ?? (await api.file(fileId)).file;

  /** How the page draws itself: 'standard', or every block marked as an item. */
  let style = doc.style === 'bulleted' ? 'bulleted' : 'standard';
  /**
   * The kind of line a blank page starts with, and the kind Enter makes when
   * the line it came from has no list kind of its own. A standard document
   * that seeded itself with a bullet — and then answered every Enter with
   * another one — was a bulleted document wearing the other name.
   */
  const plainType = () => (style === 'bulleted' ? 'bullet' : 'paragraph');
  let blocks = doc.blocks.length ? doc.blocks : [blankBlock({ type: plainType() })];
  const getDeck = deckResolver(fileId);
  let revision = doc.revision;
  let dirty = false;
  let saving = false;
  let saveTimer = null;

  /**
   * Undo, at the level of the document rather than the field.
   *
   * contenteditable gives each line its own undo stack, which is no use once a
   * line has been moved, split or deleted — the edit that needs taking back is
   * usually the one that changed the shape of the page. States are coalesced
   * so a run of typing collapses into one step instead of fifty.
   */
  const history = [];
  let snapshot = JSON.stringify(blocks);
  let snapshotAt = 0;
  const COALESCE_MS = 700;

  function remember() {
    const now = JSON.stringify(blocks);
    if (now === snapshot) return;
    const structural = JSON.parse(now).length !== JSON.parse(snapshot).length;
    if (structural || Date.now() - snapshotAt > COALESCE_MS) {
      history.push(snapshot);
      if (history.length > 60) history.shift();
      snapshotAt = Date.now();
    }
    snapshot = now;
  }

  function undo() {
    const previous = history.pop();
    if (!previous) { toast('Nothing to undo.'); return; }
    blocks = JSON.parse(previous);
    snapshot = previous;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
    draw();
  }

  const status = el('span', { class: 'save-state' }, el('span', { text: `Saved ${relative(doc.updated_at)}` }));
  const dock = el('div', { class: 'doc-dock' });
  const quiz = el('div', { class: 'doc-quiz hidden' });
  let quizOpen = false;
  /** The line the caret is in, so the format bar has something to act on. */
  let focusedId = null;
  const page = el('div', { class: 'doc-page' });
  /** The pages that point here, drawn under the document rather than beside it. */
  const refs = el('div', { class: 'doc-refs' });
  /* Tags above the page and what shares them below it. A `##tag` typed into
     the text lands in the same place as one attached from the menu, so the
     strip is the page's whole answer to "what is this about". */
  const tags = tagStrip({ itemType: 'file', itemId: fileId, title: file.title });
  const related = relatedPanel({ itemType: 'file', itemId: fileId });

  /* ── saving ────────────────────────────────────────────────────────── */

  const setStatus = (node) => mount(status, node);

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    dirty = false;
    setStatus(el('span', null, el('span', { class: 'spinner', style: { width: '11px', height: '11px' } }), ' Saving…'));

    // Empty trailing blocks are working state, not content — drop them so the
    // stored document matches what the page actually shows.
    const payload = blocks.filter((b, i) => !(i === blocks.length - 1 && isEmpty(b)));

    try {
      const res = await api.saveDocument(fileId, payload.length ? payload : [], revision, style);
      revision = res.document.revision;
      tellCopies(fileId, self, { blocks: payload, style, revision });
      setStatus(el('span', { text: 'Saved just now' }));
      // The links out of this page have just been re-indexed, so what points
      // back at it may have changed too — a [[link]] typed a moment ago, or a
      // ##tag that has just put this page beside three others.
      void drawRefs();
      void tags.refresh();
      void related.refresh();
      void loadTags();
    } catch (err) {
      if (err?.status === 409) {
        // Another window — or another Mac — saved first. Neither version is
        // thrown away without asking: silently winning loses their edits, and
        // silently losing loses what was just typed here.
        const fresh = await api.document(fileId);
        const choice = await dialog({
          title: 'This page was changed somewhere else',
          body: el('p', { class: 'muted', text: 'Another window saved a different version while you were typing here. Keep the version on this screen, or take theirs?' }),
          confirmLabel: 'Keep mine',
          cancelLabel: 'Keep theirs',
          onConfirm: () => true,
        });
        if (choice) {
          revision = fresh.document.revision;
          dirty = true;
          setStatus(el('span', { text: 'Unsaved changes' }));
        } else {
          blocks = fresh.document.blocks.length ? fresh.document.blocks : [blankBlock({ type: plainType() })];
          style = fresh.document.style === 'bulleted' ? 'bulleted' : 'standard';
          revision = fresh.document.revision;
          snapshot = JSON.stringify(blocks);
          setStatus(el('span', { text: 'Took the other version' }));
          draw();
        }
      } else {
        dirty = true;
        setStatus(el('span', { style: { color: 'oklch(0.78 0.12 25)' }, text: 'Not saved' }));
        reportError(err);
      }
    } finally {
      saving = false;
      if (dirty) queue();
    }
  }

  /** Another copy of this page saved: move to what it wrote. */
  const self = {
    adopt(saved) {
      revision = saved.revision;
      if (dirty || saving) return; // our own save will now go in on top, not collide
      const caret = page.contains(document.activeElement) ? focusedId : null;
      blocks = saved.blocks.length ? structuredClone(saved.blocks) : [blankBlock({ type: plainType() })];
      style = saved.style;
      snapshot = JSON.stringify(blocks);
      draw();
      if (caret) focusBlock(caret, true);
      setStatus(el('span', { text: 'Saved just now' }));
    },
  };
  const leaveCopies = joinCopies(fileId, self);

  function queue() {
    remember();
    dirty = true;
    setStatus(el('span', { text: 'Unsaved changes' }));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  /* ── outline structure ─────────────────────────────────────────────── */

  /** The block types that take part in the outline tree. */
  const NESTED = new Set(['bullet', 'numbered']);

  function indentOf(block) { return NESTED.has(block.type) ? (block.indent ?? 0) : 0; }

  /**
   * The run of lines nested under `index`. Depth is carried by each line's own
   * indent rather than by nesting the data, so a subtree is a contiguous range
   * — which is also why moving one line has to move the range with it.
   */
  function subtree(index) {
    const base = indentOf(blocks[index]);
    let end = index + 1;
    while (end < blocks.length && NESTED.has(blocks[end].type) && indentOf(blocks[end]) > base) end += 1;
    return { start: index + 1, end };
  }

  function childCount(index) {
    const { start, end } = subtree(index);
    return end - start;
  }

  /** Lines hidden because a line above them is collapsed. */
  function hiddenLines() {
    const hidden = new Set();
    for (let i = 0; i < blocks.length; i += 1) {
      if (!blocks[i].collapsed) continue;
      const { start, end } = subtree(i);
      for (let j = start; j < end; j += 1) hidden.add(j);
    }
    return hidden;
  }

  /**
   * Indents or outdents a line and everything under it. A line may sit at most
   * one level deeper than the line above it — a bigger jump would draw a level
   * with nothing in it, which the reader cannot tell from a mistake.
   */
  function shiftIndent(index, delta) {
    const block = blocks[index];
    if (!NESTED.has(block.type)) return;
    const previous = blocks[index - 1];
    const ceiling = previous && NESTED.has(previous.type) ? indentOf(previous) + 1 : 0;
    const next = Math.max(0, Math.min(6, ceiling, indentOf(block) + delta));
    if (next === indentOf(block)) return;

    const move = next - indentOf(block);
    const { start, end } = subtree(index);
    blocks[index] = { ...block, indent: next };
    for (let j = start; j < end; j += 1) {
      blocks[j] = { ...blocks[j], indent: Math.max(0, Math.min(6, indentOf(blocks[j]) + move)) };
    }
    queue();
    draw();
    focusBlock(block.id, true);
  }

  /* ── inline cards ──────────────────────────────────────────────────── */

  /**
   * Brings this line's card into line with its text. Runs on blur rather than
   * on every keystroke: a half-typed `question ==` is not a card yet, and the
   * deck should not fill up with the shapes a sentence passes through.
   */
  /**
   * The answer a question takes from the lines indented under it.
   *
   * Some answers are a list — the causes of a war, the stages of a process —
   * and writing them out along one line to make a card of them is writing the
   * same thing twice. The children are already the answer, in the order and
   * the depth they were written in, so they are read as one.
   */
  function listAnswer(index) {
    const { start, end } = subtree(index);
    const base = indentOf(blocks[index]);
    const lines = [];
    for (let i = start; i < end; i += 1) {
      const child = blocks[i];
      const text = stripMarks(child.text ?? '').trim();
      if (!text) continue;
      lines.push(`${'  '.repeat(Math.max(0, indentOf(child) - base - 1))}• ${text}`);
    }
    return lines.join('\n');
  }

  /**
   * What this line would ask as a card, or null if it would ask nothing.
   *
   * Either both halves are on the line, or the question is on the line and the
   * answer is the list under it.
   */
  function cardText(index) {
    const block = blocks[index];
    if (!block || block.type !== 'bullet') return null;
    // A bullet written as a `{{c1::…}}` cloze is one card carrying the markup,
    // sitting alongside the `question == answer` line the deck already knows.
    if (isCloze(block.text)) return block.text;
    if (parseCard(block.text)) return block.text;

    const open = openCard(block.text);
    if (!open) return null;
    const answer = listAnswer(index);
    return answer ? `${open.front} ${open.separator} ${answer}` : null;
  }

  async function syncBlockCard(id) {
    const at = blocks.findIndex((b) => b.id === id);
    if (at === -1) return;
    const block = blocks[at];
    const text = cardText(at);
    if (!text) return;

    const result = await syncCard({ text, cardId: block.cardId ?? null, getDeck });
    const now = blocks.findIndex((b) => b.id === id);
    if (now === -1 || result.failed) return;
    if ((blocks[now].cardId ?? null) === result.cardId) return;

    blocks[now] = { ...blocks[now], cardId: result.cardId };
    queue();
    draw();
  }

  /**
   * Where a line sits in the page's tree: the headings above it, outermost
   * first, as the card's topic — which is what groups a deck's cloze cards
   * under the sections they were written in — and the lines it is indented
   * under, which the card shows above its question.
   */
  function contextOf(index) {
    const headings = [];
    let level = Infinity;
    for (let i = index - 1; i >= 0 && level > 1; i -= 1) {
      const b = blocks[i];
      if (b.type !== 'heading' || (b.level ?? 1) >= level) continue;
      const name = stripMarks(b.text ?? '').trim();
      level = b.level ?? 1;
      if (name) headings.unshift(name);
    }
    if (blocks[index]?.type === 'heading') headings.length = 0;
    const parents = [];
    let depth = indentOf(blocks[index]);
    for (let i = index - 1; i >= 0 && depth > 0; i -= 1) {
      if (!NESTED.has(blocks[i].type)) break;
      if (indentOf(blocks[i]) >= depth) continue;
      depth = indentOf(blocks[i]);
      const name = stripMarks(clozeQuestion(blocks[i].text ?? '', -1)).trim();
      if (name) parents.unshift(name);
    }
    const topic = headings.join(' › ').slice(0, 120) || null;
    return { topic, parents };
  }

  /**
   * Cards from the `{blanks}` in a line.
   *
   * One card per blank, so a sentence with three things worth knowing is three
   * things to be asked rather than one card you get "half right". The ids live
   * on the block, in order, which is what lets an edit update the existing
   * cards instead of leaving a trail of orphans behind every keystroke.
   *
   * Like the separator cards this runs on blur: a `{` typed a second ago is
   * not a blank yet, it is the start of one.
   */
  async function syncClozeCards(id) {
    const at = blocks.findIndex((b) => b.id === id);
    if (at === -1) return;
    const block = blocks[at];
    if (!CLOZEABLE.has(block.type)) return;

    const blanks = inlineClozes(block.text ?? '');
    const existing = Array.isArray(block.clozeCardIds) ? block.clozeCardIds : [];
    if (!blanks.length && !existing.length) return;

    const ids = [...existing];
    const { topic, parents } = contextOf(at);
    try {
      for (let i = 0; i < blanks.length; i += 1) {
        const question = stripMarks(clozeQuestion(block.text ?? '', i));
        if (!question.trim() || !blanks[i].trim()) continue;
        // The lines this one hangs from are part of what it means, so the
        // card carries them above the question the way the page does.
        const front = parents.length ? `${parents.join(' › ')}\n${question}` : question;
        if (ids[i]) {
          await api.updateCard(ids[i], { front, back: blanks[i], topic });
        } else {
          const deck = await getDeck();
          const { card } = await api.createCard({
            deckId: deck.id, front, back: blanks[i], topic, sourceFileId: fileId,
          });
          ids[i] = card.id;
        }
      }
      // A blank that has been taken out of the sentence takes its card with
      // it: the question it asked no longer exists anywhere on the page.
      for (const stale of ids.slice(blanks.length)) {
        if (stale) await api.deleteCard(stale).catch(() => {});
      }
    } catch (err) { reportError(err); return; }

    const next = ids.slice(0, blanks.length);
    const now = blocks.findIndex((b) => b.id === id);
    if (now === -1) return;
    if (JSON.stringify(blocks[now].clozeCardIds ?? []) === JSON.stringify(next)) return;
    blocks[now] = { ...blocks[now], clozeCardIds: next };
    queue();
    draw();
    if (next.length > existing.length) {
      toast(`${plural(next.length - existing.length, 'cloze card')} added.`);
      void loadLibrary();
    }
  }

  /** The line kinds a `{blank}` turns into a card on. */
  const CLOZEABLE = new Set(['paragraph', 'bullet', 'numbered', 'todo', 'heading', 'quote']);

  /**
   * Everything a line owes the deck, in one call.
   *
   * The line above is asked as well, because a question whose answer is the
   * list underneath it changes when the list does — and the line being left is
   * the list, not the question.
   */
  function syncLine(id) {
    void syncBlockCard(id);
    void syncClozeCards(id);

    const at = blocks.findIndex((b) => b.id === id);
    if (at <= 0) return;
    const base = indentOf(blocks[at]);
    for (let i = at - 1; i >= 0; i -= 1) {
      if (indentOf(blocks[i]) >= base) continue;
      if (blocks[i].type === 'bullet' && openCard(blocks[i].text)) void syncBlockCard(blocks[i].id);
      return;
    }
  }

  /* ── rendering ─────────────────────────────────────────────────────── */

  /**
   * Standard or bulleted, on the page itself rather than in a settings panel.
   * It changes how these notes read, so it belongs where they are read.
   */
  /** Standard or Bulleted, offered in the ⋯ menu with a tick on the current one. */
  function styleItems() {
    const option = (id, label) => ({
      icon: style === id ? 'check' : (id === 'bulleted' ? 'list-bullets' : 'text-align-left'),
      label,
      onSelect: () => {
        if (style === id) return;
        style = id;
        queue();
        draw();
      },
    });
    return [{ head: 'Page style' }, option('standard', 'Standard'), option('bulleted', 'Bulleted')];
  }

  function draw() {
    page.dataset.style = style;
    mount(page,
      el('div', null,
        el('div', { class: 'doc-kicker', text: (file.folder_id ? folderById(file.folder_id)?.name : null)?.toUpperCase() ?? 'NOTES' }),
        el('h2', { class: 'doc-title', text: file.title }),
      ),
      ...drawLines(),
    );
    drawDock();
    if (selected.size) paintSelection();
  }

  /**
   * The page, in order, with side-by-side bullets folded into their columns.
   *
   * A line is normally its own row, which is what a written page is. The one
   * exception is a bullet asked to hold its children side by side: pros and
   * cons, a comparison, two halves of an argument. That is still one list in
   * the file — the children keep their indent and their order, so turning the
   * layout off puts the page back exactly as it was — it is only drawn across
   * instead of down.
   */
  function drawLines() {
    const hidden = hiddenLines();
    const out = [];

    for (let i = 0; i < blocks.length; i += 1) {
      if (hidden.has(i)) continue;
      const block = blocks[i];
      out.push(renderBlock(block, i));

      if (block.type !== 'bullet' || block.layout !== 'columns' || block.collapsed) continue;
      const { start, end } = subtree(i);
      if (end <= start) continue;

      const base = indentOf(block);
      const columns = [];
      let j = start;
      while (j < end) {
        const span = subtree(j);
        const lines = [];
        for (let k = j; k < span.end; k += 1) {
          if (hidden.has(k)) continue;
          const node = renderBlock(blocks[k], k);
          // A column starts at its own margin: the indent that puts these
          // lines under the parent is what made them a column in the first
          // place, so drawing it again would indent every column by a level.
          const pad = Number.parseFloat(node.style.paddingLeft || '0');
          node.style.paddingLeft = `${Math.max(0, pad - (base + 1) * 22)}px`;
          lines.push(node);
        }
        columns.push(el('div', { class: 'bcol' }, ...lines));
        j = span.end;
      }

      out.push(el('div', {
        class: 'bullet-columns',
        style: {
          gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
          marginLeft: `${(base + 1) * 22}px`,
        },
      }, ...columns));
      i = end - 1;
    }
    return out;
  }

  function replace(index, next) {
    blocks[index] = next;
    queue();
  }

  function insertAfter(index, spec) {
    const block = blankBlock(spec);
    blocks.splice(index + 1, 0, block);
    queue();
    draw();
    focusBlock(block.id);
  }

  function removeAt(index) {
    if (blocks.length === 1) return;
    blocks.splice(index, 1);
    queue();
    draw();
    const prev = blocks[Math.max(0, index - 1)];
    if (prev) focusBlock(prev.id, true);
  }

  /**
   * Moves a line past its neighbour, carrying everything nested under it. A
   * line and its children are one thing on the page, so they are one thing to
   * move — swapping the line alone would drop it into someone else's subtree.
   */
  function moveBlock(index, direction) {
    remember();
    const { end } = subtree(index);
    const run = blocks.slice(index, end);

    if (direction < 0) {
      if (index === 0) return;
      // The neighbour above is the start of whichever subtree ends at `index`.
      let target = index - 1;
      while (target > 0 && indentOf(blocks[target]) > indentOf(blocks[index])) target -= 1;
      blocks.splice(index, run.length);
      blocks.splice(target, 0, ...run);
    } else {
      if (end >= blocks.length) return;
      const next = subtree(end);
      const after = next.end;
      blocks.splice(index, run.length);
      blocks.splice(after - run.length, 0, ...run);
    }
    queue();
    draw();
  }

  function focusBlock(id, atEnd = false) {
    const node = page.querySelector(`[data-block="${id}"] .btext`);
    if (!node) return;
    node.focus();
    if (!atEnd) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ── selecting whole lines ─────────────────────────────────────────── */

  /*
   * Every line is its own editable field, so the browser's own selection stops
   * at the edge of the line it started in. Dragging past that edge — or
   * Shift-clicking another line — selects the lines themselves instead, which
   * is what the hand dragging down a page meant: these, to move, copy or cut.
   */
  let selected = new Set();
  let selectAnchor = null;
  let dragFrom = null;

  const indexOfId = (id) => blocks.findIndex((b) => b.id === id);

  /** The top-level line under a node, skipping any line drawn inside another. */
  function lineAt(target) {
    let node = target?.closest?.('[data-block]');
    while (node && indexOfId(node.dataset.block) === -1) node = node.parentElement?.closest('[data-block]');
    return node?.dataset.block ?? null;
  }

  function paintSelection() {
    for (const node of page.querySelectorAll('[data-block]')) {
      node.classList.toggle('selected', selected.has(node.dataset.block));
    }
    page.classList.toggle('selecting', selected.size > 0);
  }

  function selectLines(fromId, toId) {
    const a = indexOfId(fromId);
    const b = indexOfId(toId);
    if (a === -1 || b === -1) return;
    selectAnchor = fromId;
    selected = new Set(blocks.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id));
    window.getSelection()?.removeAllRanges();
    if (page.contains(document.activeElement)) document.activeElement.blur();
    paintSelection();
  }

  function clearSelection() {
    if (!selected.size) return;
    selected = new Set();
    selectAnchor = null;
    paintSelection();
  }

  function selectedText() {
    return blocks.filter((b) => selected.has(b.id)).map((b) => {
      const pad = '  '.repeat(indentOf(b));
      const text = stripMarks(b.text ?? (b.front ? `${b.front} — ${b.back ?? ''}` : ''));
      if (b.type === 'bullet') return `${pad}• ${text}`;
      if (b.type === 'todo') return `${pad}${b.done ? '[x]' : '[ ]'} ${text}`;
      return pad + text;
    }).join('\n');
  }

  async function deleteSelected() {
    const doomed = blocks.filter((b) => selected.has(b.id));
    if (!doomed.length) return;
    const images = doomed.filter((b) => b.type === 'image' && b.imageId);
    if (images.length) {
      const ok = await confirmDelete(`${plural(images.length, 'image')} will be deleted for good, and the space given back.`, { confirmLabel: 'Delete' });
      if (!ok) return;
      for (const image of images) await api.deleteImage(image.imageId).catch(reportError);
    }
    remember();
    blocks = blocks.filter((b) => !selected.has(b.id));
    if (!blocks.length) blocks.push(blankBlock({ type: plainType() }));
    selected = new Set();
    selectAnchor = null;
    queue();
    draw();
    // No caret goes back into a line, so the next ⌘Z is the page's undo and
    // not the field's — the field has nothing of these lines to give back.
    toast(`${plural(doomed.length, 'line')} deleted. ⌘Z brings ${doomed.length === 1 ? 'it' : 'them'} back.`);
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const id = page.contains(event.target) ? lineAt(event.target) : null;
    if (event.shiftKey && id) {
      const anchor = selectAnchor ?? focusedId;
      if (anchor && anchor !== id && indexOfId(anchor) !== -1) {
        event.preventDefault();
        selectLines(anchor, id);
        return;
      }
    }
    clearSelection();
    dragFrom = id;
  };

  const onPointerMove = (event) => {
    if (!dragFrom) return;
    if (!(event.buttons & 1)) { dragFrom = null; return; }
    const id = lineAt(document.elementFromPoint(event.clientX, event.clientY));
    if (!id) return;
    if (id !== dragFrom) selectLines(dragFrom, id);
    else if (selected.size) clearSelection();
  };

  const onPointerUp = () => { dragFrom = null; };

  const onSelectionKey = (event) => {
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const typing = document.activeElement?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (meta && !event.shiftKey && !event.altKey && key === 'z' && !typing && document.querySelector('.doc-page') === page) {
      event.preventDefault();
      clearSelection();
      undo();
      return;
    }
    if (!selected.size) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSelection();
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      void deleteSelected();
    } else if (meta && (key === 'c' || key === 'x')) {
      event.preventDefault();
      void navigator.clipboard?.writeText(selectedText());
      if (key === 'x') void deleteSelected();
      else toast(`${plural(selected.size, 'line')} copied.`);
    } else if (meta && key === 'a') {
      event.preventDefault();
      selectLines(blocks[0].id, blocks[blocks.length - 1].id);
    } else if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const ids = blocks.filter((b) => selected.has(b.id)).map((b) => b.id);
      const anchorAt = indexOfId(selectAnchor);
      const edge = indexOfId(ids[0] === selectAnchor ? ids[ids.length - 1] : ids[0]);
      const next = Math.max(0, Math.min(blocks.length - 1, edge + (event.key === 'ArrowUp' ? -1 : 1)));
      if (anchorAt !== -1) selectLines(selectAnchor, blocks[next].id);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const delta = event.shiftKey ? -1 : 1;
      blocks = blocks.map((b) => (selected.has(b.id) && NESTED.has(b.type)
        ? { ...b, indent: Math.max(0, Math.min(6, indentOf(b) + delta)) }
        : b));
      queue();
      draw();
    } else if (!['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) {
      clearSelection();
    }
  };

  /* The Edit menu's Copy and Cut arrive as events, not keys. */
  const onClipboard = (event) => {
    if (!selected.size || page.contains(document.activeElement)) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', selectedText());
    if (event.type === 'cut') void deleteSelected();
  };

  /* A file dragged from the library onto the page lands as a line where it
     was let go: a PDF as a linked attachment, a canvas as a diagram, a note as
     a link. Stopping the event keeps the pane from opening it instead. */
  let dropMark = null;
  const clearDropMark = () => { dropMark?.classList.remove('drop-above', 'drop-below'); dropMark = null; };
  const dropSpot = (event) => {
    const id = lineAt(event.target) ?? lineAt(document.elementFromPoint(event.clientX, event.clientY));
    const node = id ? page.querySelector(`[data-block="${CSS.escape(id)}"]`) : null;
    if (!node) return { node: null, index: blocks.length - 1, below: true };
    const box = node.getBoundingClientRect();
    return { node, index: indexOfId(id), below: event.clientY > box.top + box.height / 2 };
  };
  page.addEventListener('dragover', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    const { node, below } = dropSpot(event);
    if (node !== dropMark) clearDropMark();
    if (node) {
      node.classList.toggle('drop-below', below);
      node.classList.toggle('drop-above', !below);
      dropMark = node;
    }
  });
  page.addEventListener('dragleave', (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && page.contains(to)) return;
    clearDropMark();
  });
  page.addEventListener('drop', (event) => {
    if (!carriesItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const spot = dropSpot(event);
    clearDropMark();
    const item = readItem(event);
    const files = (item?.items ?? (item ? [item] : [])).filter((one) => one.kind === 'file' && one.id !== fileId);
    if (!files.length) { if (item?.id === fileId) toast('That is this page.'); return; }
    remember();
    let at = spot.below ? spot.index + 1 : Math.max(0, spot.index);
    for (const one of files) {
      const target = fileById(one.id);
      const kind = one.fileKind ?? target?.kind;
      const title = target?.title ?? one.title ?? 'Untitled';
      let block;
      if (kind === 'pdf') block = { id: crypto.randomUUID(), type: 'pdf', fileId: one.id, page: 1 };
      else if (kind === 'canvas') block = { id: crypto.randomUUID(), type: 'canvas', fileId: one.id, caption: null };
      else block = { ...blankBlock({ type: 'paragraph' }), text: `[[${title}]]` };
      blocks.splice(at, 0, block);
      at += 1;
    }
    queue();
    draw();
    toast(files.length === 1 ? `Added “${fileById(files[0].id)?.title ?? files[0].title}”.` : `Added ${files.length} files.`);
  });

  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('mouseup', onPointerUp);
  document.addEventListener('keydown', onSelectionKey, true);
  document.addEventListener('copy', onClipboard);
  document.addEventListener('cut', onClipboard);

  /* ── format bar ────────────────────────────────────────────────────── */

  /** Changes what a line *is*, keeping what it says. */
  /** `at` defaults to the line the caret is in, which is what the dock acts on. */
  function convert(spec, at = -2) {
    const index = at === -2 ? blocks.findIndex((b) => b.id === focusedId) : at;
    const current = blocks[index];
    if (!current) return;
    const text = current.text ?? '';
    const next = blankBlock({ ...spec, indent: indentOf(current) });
    if ('text' in next) next.text = text;
    // A line that was already a card keeps its card: the words did not change,
    // only the shape of the line around them.
    if (next.type === 'bullet' && current.cardId) next.cardId = current.cardId;
    // Its blanks keep their cards too, for the same reason — every line that
    // can hold running text can hold a `{blank}`, so this survives the change.
    if ('clozeCardIds' in next && Array.isArray(current.clozeCardIds)) {
      next.clozeCardIds = [...current.clozeCardIds];
    }
    blocks[index] = next;
    queue();
    draw();
    focusBlock(next.id, true);
  }

  function insert(spec) {
    const index = blocks.findIndex((b) => b.id === focusedId);
    insertAfter(index === -1 ? blocks.length - 1 : index, spec);
  }

  const HEADINGS = [
    { spec: { type: 'paragraph' }, glyph: 'text-align-left', label: 'Text' },
    { spec: { type: 'heading', level: 1 }, glyph: 'text-h-one', label: 'Heading 1' },
    { spec: { type: 'heading', level: 2 }, glyph: 'text-h-two', label: 'Heading 2' },
    { spec: { type: 'heading', level: 3 }, glyph: 'text-h-three', label: 'Heading 3' },
  ];

  const MORE = [
    { spec: { type: 'bullet' }, glyph: 'list-bullets', label: 'Bulleted list' },
    { spec: { type: 'numbered' }, glyph: 'list-numbers', label: 'Numbered list' },
    { spec: { type: 'code' }, glyph: 'code', label: 'Code' },
    { spec: { type: 'math' }, glyph: 'function', label: 'Equation' },
    { spec: { type: 'divider' }, glyph: 'minus', label: 'Divider' },
  ];

  function matches(block, spec) {
    if (!block || block.type !== spec.type) return false;
    return spec.level === undefined || block.level === spec.level;
  }

  /**
   * The dock floats over the page rather than sitting in a bar above it: the
   * page is the document, and the controls are visiting.
   *
   * Every button commits on mousedown. A click would first move focus off the
   * line being edited, and the caret is what these act on.
   */
  function drawDock() {
    const current = blocks.find((b) => b.id === focusedId) ?? null;

    // Rows the More menu takes over when the pane is too narrow to show their
    // buttons. Which ones are hidden is the stylesheet's call (a container
    // query on the pane), so the menu asks the buttons rather than guessing.
    const spill = [];
    const item = (glyph, label, onPress, opts = {}) => {
      const node = el('button', {
        class: [opts.on && 'on', opts.disabled && 'off', opts.compact && 'compact', opts.tier && `tier-${opts.tier}`].filter(Boolean).join(' '),
        title: opts.title ?? label,
        'aria-label': label,
        onmousedown: (e) => { e.preventDefault(); if (!opts.disabled) onPress(e); },
      },
        el('span', { class: 'g' }, icon(glyph, { size: 17 }), opts.caret ? icon('caret-down', { size: 9 }) : null),
        opts.compact ? null : el('span', { class: 'l', text: label }),
      );
      if (opts.tier && !opts.disabled) {
        spill.push({ node, rows: opts.rows ?? [{ icon: glyph, label, onSelect: () => onPress(null) }] });
      }
      return node;
    };
    const sep = (tier) => el('span', { class: tier ? `sep tier-${tier}` : 'sep' });
    const hidden = (node) => node.getClientRects().length === 0;

    // The bar holds what a writer reaches for mid-sentence; everything else is
    // one click away under More, so the bar stays a short strip of icons.
    const disabled = !formattable(current);
    mount(dock,
      item('cards', 'Flashcard', () => cardFromLine(), {
        compact: true,
        title: 'Turn this line into a flashcard (Question :: Answer)',
        on: Boolean(current && current.type === 'bullet'
          && cardText(blocks.findIndex((b) => b.id === current.id))),
      }),
      item('text-h-one', 'Heading', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openMenu({ x: rect.left, y: rect.top - 8, anchorBottom: true },
          HEADINGS.map((h) => ({ icon: h.glyph, label: h.label, on: matches(current, h.spec), onSelect: () => convert(h.spec) })));
      }, { compact: true, caret: true, title: 'Heading', on: current?.type === 'heading' }),
      sep(),
      item('text-b', 'Bold', () => applyMark('bold'), { compact: true, tier: 3, title: 'Bold (⌘B)', disabled }),
      item('text-italic', 'Italic', () => applyMark('italic'), { compact: true, tier: 3, title: 'Italic (⌘I)', disabled }),
      item('highlighter-circle', 'Highlight', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openMenu({ x: rect.left, y: rect.top - 8, anchorBottom: true },
          HIGHLIGHTS.map((hue) => ({
            icon: 'highlighter-circle',
            label: colorLabel(hue),
            onSelect: () => applyHighlight(hue),
          })));
      }, {
        compact: true, caret: true, tier: 2, title: 'Highlight (⌘⇧H)', disabled,
        rows: HIGHLIGHTS.map((hue) => ({
          icon: 'highlighter-circle',
          label: `Highlight ${colorLabel(hue).toLowerCase()}`,
          onSelect: () => applyHighlight(hue),
        })),
      }),
      item('brackets-curly', 'Cloze', () => wrapSelection('{', '}', { placeholder: 'answer' }), {
        compact: true, tier: 2, title: 'Cloze: hide this as a blank — it becomes a card (⌘⇧C)', disabled,
      }),
      sep(2),
      item('dots-three', 'More', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const tucked = spill.filter((s) => hidden(s.node)).flatMap((s) => s.rows);
        openMenu({ x: rect.left, y: rect.top - 8, anchorBottom: true }, [
          ...tucked,
          tucked.length ? { sep: true } : null,
          { icon: 'check-square', label: 'Todo', on: current?.type === 'todo', onSelect: () => convert({ type: 'todo' }) },
          { icon: 'table', label: 'Table', onSelect: () => insert({ type: 'table' }) },
          { icon: 'image', label: 'Image', onSelect: () => pickImage() },
          ...MORE.map((m) => ({ icon: m.glyph, label: m.label, on: matches(current, m.spec), onSelect: () => convert(m.spec) })),
          { sep: true },
          disabled ? null : { icon: 'text-underline', label: 'Underline', kbd: '⌘U', onSelect: () => applyMark('underline') },
          disabled ? null : { icon: 'code', label: 'Inline code', kbd: '⌘E', onSelect: () => applyMark('code') },
          disabled ? null : { icon: 'link-simple', label: 'Link to a page', kbd: '⇧⌘K', onSelect: () => wrapSelection('[[', ']]', { placeholder: 'Page' }) },
          disabled ? null : { icon: 'hash', label: 'Tag', kbd: '⇧⌘T', onSelect: () => wrapSelection('##', '', { placeholder: 'topic' }) },
          { sep: true },
          { icon: 'text-indent', label: 'Indent', kbd: 'Tab', onSelect: () => nudge(1) },
          { icon: 'text-outdent', label: 'Outdent', kbd: '⇧Tab', onSelect: () => nudge(-1) },
        ].filter(Boolean));
      }, { compact: true, title: 'More' }),
      item('arrow-counter-clockwise', 'Undo', () => undo(), {
        compact: true,
        title: 'Undo (⌘Z)',
        disabled: history.length === 0,
      }),
    );

  }

  /**
   * What points here, under the page.
   *
   * Under rather than beside: backlinks are something you read after the
   * document, not while writing it, and a panel down the side of a page of
   * notes is a panel that is in the way for the hour you spend typing.
   */
  async function drawRefs() {
    let rows = [];
    try { ({ backlinks: rows } = await api.backlinks(fileId)); }
    catch { mount(refs); return; }

    if (!rows.length) { mount(refs); return; }
    mount(refs,
      el('div', { class: 'refs-head' },
        icon('link-simple', { size: 13 }),
        el('span', { text: `${plural(rows.length, 'page')} link here` }),
      ),
      el('div', { class: 'refs-list' }, rows.map((row) => el('div', { class: 'ref-line' },
        el('button', {
          class: 'ref-row',
          onclick: () => navigate(`doc/${row.id}`),
        },
          icon(FILE_ICON[row.kind] ?? 'file-text', { size: 14 }),
          el('span', { class: 'grow', text: row.title || 'Untitled' }),
          icon('caret-right', { size: 11 }),
        ),
        // Following a reference beside this page keeps the page being read.
        el('button', {
          class: 'ref-beside', type: 'button', title: 'Open Beside', 'aria-label': `Open ${row.title || 'Untitled'} beside`,
          onclick: () => openBeside(`doc/${row.id}`),
        }, icon('columns', { size: 13 })),
      ))),
    );
  }

  /**
   * The Flashcard button, on whichever line the caret is in: it writes the
   * separator so the line becomes a card, rather than opening a form that
   * would put the answer somewhere other than the page.
   */
  function cardFromLine() {
    const index = blocks.findIndex((b) => b.id === focusedId);
    if (index === -1) { insert({ type: 'bullet' }); return; }
    const block = blocks[index];
    if (block.type !== 'bullet') { convert({ type: 'bullet' }); return; }
    if (cardText(index)) { toast('This line is already a card.'); return; }
    // A line already asking a question is waiting for its answer, not for a
    // second separator: leave the caret where the answer goes.
    if (openCard(block.text)) { focusBlock(block.id, true); return; }

    const text = (block.text ?? '').trim();
    blocks[index] = { ...block, text: text ? `${text} :: ` : ' :: ' };
    queue();
    draw();
    focusBlock(block.id, true);
  }

  function nudge(delta) {
    const index = blocks.findIndex((b) => b.id === focusedId);
    if (index !== -1) shiftIndent(index, delta);
  }

  /**
   * What a line turns into when it starts with a familiar mark. Typing is how
   * a writer changes a line's kind; the format bar is for when they would
   * rather point at it.
   */
  const SHORTCUTS = [
    [/^# $/, { type: 'heading', level: 1 }],
    [/^## $/, { type: 'heading', level: 2 }],
    [/^### $/, { type: 'heading', level: 3 }],
    [/^[-*] $/, { type: 'bullet' }],
    [/^1\. $/, { type: 'numbered' }],
    [/^\[\] $/, { type: 'todo' }],
    [/^> $/, { type: 'paragraph' }],
  ];

  /** Every text line's input handler: try the shortcut first, then just save. */
  function onText(index, block) {
    return (text) => {
      if (applyShortcut(index, text)) return;
      replace(index, { ...block, text });
    };
  }

  function applyShortcut(index, text) {
    for (const [pattern, spec] of SHORTCUTS) {
      if (!pattern.test(text)) continue;
      const current = blocks[index];
      const next = blankBlock({ ...spec, indent: indentOf(current) });
      blocks[index] = next;
      queue();
      draw();
      focusBlock(next.id, true);
      return true;
    }
    return false;
  }

  /**
   * contenteditable in plaintext-only mode: text in, text out, no markup.
   *
   * Emphasis is drawn from the marks in the text itself — `**bold**` — and the
   * marks stay in the DOM rather than being swapped out, hidden by CSS unless
   * the caret is in the line. So the rendered line spells out exactly the
   * stored string, and an offset on screen is an offset in the data. Nothing
   * here builds markup from a note's contents; every span is made by el().
   */
  function editable(value, placeholder, onInput, onKey) {
    const node = el('div', {
      class: 'btext',
      contenteditable: 'plaintext-only',
      spellcheck: 'true',
      'data-placeholder': placeholder,
    });
    node.replaceChildren(...renderInline(value ?? ''));

    node.addEventListener('input', () => onInput(node.textContent));
    node.addEventListener('focus', () => {
      const owner = node.closest('[data-block]')?.dataset.block ?? null;
      if (owner === focusedId) return;
      focusedId = owner;
      drawDock();
    });
    // Typing must not redraw the line under the caret, so the emphasis is
    // rebuilt once the caret has gone somewhere else.
    node.addEventListener('blur', () => {
      const raw = node.textContent;
      node.replaceChildren(...renderInline(raw));
      const owner = node.closest('[data-block]')?.dataset.block ?? null;
      if (owner) syncLine(owner);
    });
    if (onKey) node.addEventListener('keydown', onKey);
    wireReferences(node);
    return node;
  }

  /**
   * Makes the [[links]] and ##tags in a line go somewhere.
   *
   * A modifier is required, and that is deliberate: the line is editable, so a
   * plain click has to be allowed to put the caret in the middle of a link —
   * otherwise the one piece of text you cannot fix a typo in is the link with
   * the typo. ⌘-click follows it, the way it does everywhere else.
   */
  function wireReferences(node) {
    node.addEventListener('click', (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const span = event.target.closest?.('[data-link], [data-tag]');
      if (!span) return;
      event.preventDefault();
      const tag = span.getAttribute('data-tag');
      if (tag) { navigate(`tag/${encodeURIComponent(tag.toLowerCase())}`); return; }
      void followLink(span.getAttribute('data-link'));
    });
    node.title = 'Hold ⌘ and click a [[link]] or ##tag to follow it';
  }

  /**
   * Opens the page a [[link]] names, offering to make it when there is none.
   *
   * Links resolve by title rather than by id on purpose: a link is allowed to
   * name a page that does not exist yet, which is how an outline gets written
   * before the pages under it do.
   */
  async function followLink(name) {
    if (!name) return;
    try {
      const { file: found } = await api.documentByTitle(name);
      if (found) { navigate(`doc/${found.id}`); return; }
      const make = await dialog({
        title: `There is no page called “${name}”`,
        confirmLabel: 'Create it',
        body: el('div', { class: 'dim', text: 'A new document with that title, in this document’s folder.' }),
      });
      if (!make) return;
      const { file: created } = await api.createFile({
        kind: 'doc', title: name, folderId: file.folder_id ?? null,
      });
      await loadLibrary();
      navigate(`doc/${created.id}`);
    } catch (err) { reportError(err); }
  }

  /** Whether a line can carry emphasis at all. Code and dividers cannot. */
  function formattable(block) {
    return Boolean(block) && ['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'quote'].includes(block.type);
  }

  /**
   * Bold, italic or underline over whatever is selected in the focused line.
   *
   * The marks are written into the line's own text, so this is an edit like
   * any other — which is why it goes through the same save path, and why an
   * emphasised line is still a line of text when it is searched or exported.
   */
  function applyMark(key) {
    const index = blocks.findIndex((b) => b.id === focusedId);
    if (index === -1 || !formattable(blocks[index])) return;
    const node = page.querySelector(`[data-block="${focusedId}"] .btext`);
    if (!node) return;

    const at = caretRange(node) ?? { start: node.textContent.length, end: node.textContent.length };
    const next = toggleMark(node.textContent, at.start, at.end, key);
    node.textContent = next.text;
    setCaretRange(node, next.start, next.end);
    replace(index, { ...blocks[index], text: next.text });
  }

  /**
   * Puts a pair of delimiters around whatever is selected in the focused line.
   *
   * Cloze blanks and wiki links are not symmetric the way `**` is, so they
   * cannot go through toggleMark — and with nothing selected the pair is
   * written with the caret between its halves, which is what someone who
   * pressed the button before typing the word meant.
   */
  function wrapSelection(open, close, { placeholder = '' } = {}) {
    const index = blocks.findIndex((b) => b.id === focusedId);
    if (index === -1 || !formattable(blocks[index])) return;
    const node = page.querySelector(`[data-block="${focusedId}"] .btext`);
    if (!node) return;

    const raw = node.textContent;
    const at = caretRange(node) ?? { start: raw.length, end: raw.length };
    const inner = raw.slice(at.start, at.end) || placeholder;
    node.textContent = raw.slice(0, at.start) + open + inner + close + raw.slice(at.end);
    setCaretRange(node, at.start + open.length, at.start + open.length + inner.length);
    replace(index, { ...blocks[index], text: node.textContent });
  }

  /**
   * Highlighter, in one of five colours.
   *
   * The colour is written into the text as `==amber|like this==` rather than
   * kept beside it, for the same reason bold is: the line is the record, so a
   * highlighted phrase survives being copied, exported and searched.
   */
  function applyHighlight(hue) {
    const index = blocks.findIndex((b) => b.id === focusedId);
    if (index === -1 || !formattable(blocks[index])) return;
    const node = page.querySelector(`[data-block="${focusedId}"] .btext`);
    if (!node) return;

    const raw = node.textContent;
    const at = caretRange(node) ?? { start: raw.length, end: raw.length };
    // The default colour is written plain, so the commonest case reads as the
    // `==word==` people already type rather than as `==amber|word==`.
    const prefix = hue === HIGHLIGHTS[0] ? '' : `${hue}|`;
    if (!prefix) { applyMark('highlight'); return; }
    const inner = raw.slice(at.start, at.end);
    if (!inner) { toast('Select the words to highlight first.'); return; }
    node.textContent = `${raw.slice(0, at.start)}==${prefix}${inner}==${raw.slice(at.end)}`;
    setCaretRange(node, at.start + 2 + prefix.length, at.start + 2 + prefix.length + inner.length);
    replace(index, { ...blocks[index], text: node.textContent });
  }

  function renderBlock(block, index) {
    const keys = (event) => {
      const meta = event.metaKey || event.ctrlKey;

      // Emphasis, where the hands already are.
      const letter = event.key.toLowerCase();
      if (meta && event.shiftKey && !event.altKey) {
        const shifted = {
          h: () => applyHighlight(HIGHLIGHTS[0]),
          c: () => wrapSelection('{', '}', { placeholder: 'answer' }),
          k: () => wrapSelection('[[', ']]', { placeholder: 'Page' }),
          t: () => wrapSelection('##', '', { placeholder: 'topic' }),
        }[letter];
        if (shifted) { event.preventDefault(); shifted(); return; }
      }
      const mark = { b: 'bold', i: 'italic', u: 'underline', e: 'code' }[letter];
      if (meta && !event.shiftKey && !event.altKey && mark) {
        event.preventDefault();
        applyMark(mark);
        return;
      }

      // Lines are rearranged and removed from the keyboard, which is where the
      // hands already are — there is no handle to reach for any more.
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        moveBlock(index, event.key === 'ArrowUp' ? -1 : 1);
        setTimeout(() => focusBlock(block.id, true), 0);
        return;
      }
      // ⌘⌫ is the Mac's own "delete to the start of the line": it removes
      // text and never the line, so it is left to the text field.

      if (event.key === 'Tab' && NESTED.has(block.type)) {
        event.preventDefault();
        shiftIndent(index, event.shiftKey ? -1 : 1);
      } else if (event.key === 'Enter' && !event.shiftKey && block.type !== 'code' && block.type !== 'math') {
        event.preventDefault();
        // A new line starts as a sibling of the one it came from, at the same
        // depth — otherwise every Enter would throw the writer back to the margin.
        const next = NESTED.has(block.type)
          ? { type: block.type, indent: indentOf(block) }
          : block.type === 'todo' ? { type: 'todo' } : { type: plainType() };
        syncLine(block.id);
        insertAfter(index, next);
      } else if (event.key === 'Backspace' && (event.currentTarget.textContent ?? '') === '') {
        event.preventDefault();
        // An indented empty line comes back to the margin before it is deleted,
        // so Backspace never removes a line the writer was only unindenting.
        // A held key stops at the empty line: it deletes text, and never runs
        // on up the page swallowing the lines above.
        if (event.repeat) return;
        if (NESTED.has(block.type) && indentOf(block) > 0) shiftIndent(index, -1);
        else if (blocks.length > 1) removeAt(index);
      } else if (event.key === '/' && (event.currentTarget.textContent ?? '') === '') {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openBlockMenu(rect.left, rect.bottom + 6, (spec) => {
          blocks[index] = blankBlock(spec);
          queue();
          draw();
          focusBlock(blocks[index].id);
        });
      }
    };

    const wrap = (...children) => el('div', {
      class: blockClass(block),
      dataset: { block: block.id },
      style: indentOf(block) ? { paddingLeft: `${indentOf(block) * 22}px` } : null,
    }, blockHandle(block, index), ...children);

    switch (block.type) {
      case 'heading':
        return wrap(editable(block.text, `Heading ${block.level}`, (text) => replace(index, { ...block, text }), keys));

      case 'bullet': {
        const children = childCount(index);
        const card = cardText(index);
        const line = editable(block.text, 'List item', onText(index, block), keys);

        return wrap(
          el('span', { class: 'twist' }, children
            ? el('button', {
                title: block.collapsed ? `Expand ${children} ${children === 1 ? 'line' : 'lines'}` : 'Collapse',
                onclick: () => { replace(index, { ...block, collapsed: !block.collapsed }); draw(); },
              }, icon(block.collapsed ? 'caret-right' : 'caret-down', { size: 10 }))
            : null),
          el('span', { class: 'bullet' + (block.collapsed && children ? ' ring' : ''), text: '•' }),
          line,
          block.collapsed && children ? el('span', { class: 'child-count', text: `${children}` }) : null,
          card
            ? el('span', {
                class: 'card-tag' + (block.cardId ? ' on' : ''),
                title: block.cardId ? 'Saved as a flashcard' : 'Becomes a flashcard when you leave this line',
              }, icon('cards', { size: 12 }))
            : null,
        );
      }

      case 'numbered': {
        const position = blocks.slice(0, index + 1).filter((b) => b.type === 'numbered').length;
        return wrap(
          el('span', { class: 'num', text: `${position}.` }),
          editable(block.text, 'List item', (text) => replace(index, { ...block, text }), keys),
        );
      }

      case 'todo':
        return wrap(
          el('button', {
            class: 'check' + (block.done ? ' on' : ''),
            text: block.done ? '✓' : '',
            onclick: () => { replace(index, { ...block, done: !block.done }); draw(); },
          }),
          editable(block.text, 'To do', (text) => replace(index, { ...block, text }), keys),
          block.due ? el('button', {
            class: 'due-chip' + (dueClass(block) ? ` ${dueClass(block)}` : ''),
            title: 'Change when this is due',
            onclick: () => void askDue(index),
          }, icon('calendar-blank', { size: 11 }), el('span', { text: dueLabel(block.due) })) : null,
        );

      case 'divider':
        return wrap(el('div', { class: 'divider-block' }));

      case 'code':
        return wrap(editable(block.text, 'Code', (text) => replace(index, { ...block, text }), null));

      case 'math':
        return wrap(renderEquation(block, index));

      case 'table':
        return wrap(renderTable(block, index));

      case 'flashcard':
        return wrap(renderFlashcard(block, index));

      case 'image':
        return wrap(renderImage(block, index));

      case 'pdf':
        return wrap(renderAttachment(block, index));

      case 'canvas':
        return wrap(renderDiagram(block, index));

      case 'quote':
        return wrap(renderQuote(block, index, keys));

      case 'embed':
        return wrap(renderEmbed(block, index));

      case 'portal':
        return wrap(renderPortal(block, index));

      case 'columns':
        return wrap(renderColumns(block, index));

      default:
        return wrap(editable(block.text, 'Write. # for a heading, - for a list', onText(index, block), keys));
    }
  }

  /**
   * A quotation, with whoever said it underneath.
   *
   * The attribution is a separate field rather than a second line of the
   * quote: a quote that has been read back out of the page should not have
   * "— Feynman, 1965" inside the words it claims Feynman said.
   */
  function renderQuote(block, index, keys) {
    const cite = el('div', {
      class: 'quote-cite',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Who said it (optional)',
    });
    cite.textContent = block.cite ?? '';
    cite.addEventListener('input', () =>
      replace(index, { ...blocks[index], cite: cite.textContent.slice(0, 500) || null }));

    return el('blockquote', { class: 'quote-block' },
      editable(block.text, 'Quote', (text) => replace(index, { ...blocks[index], text }), keys),
      cite,
    );
  }

  /**
   * An outside page, inside this one.
   *
   * Only the hosts in EMBED_HOSTS are framed, and even those are sandboxed:
   * an embed is something to watch while revising, not something with a say
   * in the app around it. Anything else becomes a link that opens outside,
   * which is honest about what it is rather than silently showing nothing.
   */
  function renderEmbed(block, index) {
    const framed = embedUrl(block.url ?? '');

    const address = el('input', {
      class: 'input mono small',
      value: block.url ?? '',
      placeholder: 'https://…',
      spellcheck: 'false',
    });
    const commit = () => {
      const next = address.value.trim().slice(0, 2000);
      if (next === (block.url ?? '')) return;
      replace(index, { ...blocks[index], url: next });
      draw();
    };
    address.addEventListener('change', commit);
    address.addEventListener('blur', commit);

    const caption = el('figcaption', {
      class: 'image-caption',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Caption (optional)',
    });
    caption.textContent = block.caption ?? '';
    caption.addEventListener('input', () =>
      replace(index, { ...blocks[index], caption: caption.textContent.slice(0, 500) || null }));

    const body = framed
      ? el('div', { class: 'embed-frame' }, el('iframe', {
          src: framed,
          loading: 'lazy',
          allowfullscreen: 'true',
          referrerpolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
          title: block.caption ?? 'Embedded page',
        }))
      : el('div', { class: 'embed-plain' },
          icon('globe', { size: 18 }),
          block.url
            ? el('a', { href: block.url, target: '_blank', rel: 'noreferrer noopener', text: block.url })
            : el('span', { class: 'dim', text: 'Paste a link to embed it.' }),
          block.url
            ? el('span', { class: 'dim', text: 'Opens outside Studex — this site is not one that can be shown inside a page.' })
            : null,
        );

    return el('figure', { class: 'embed-block' }, body, address, caption);
  }

  /**
   * A live window onto another page.
   *
   * The text is read from the other document each time this one is drawn and
   * is not editable here, so a portal can never be the copy that drifts: the
   * page it points at is the one with the answer, and this only shows it.
   */
  function renderPortal(block, index) {
    const body = el('div', { class: 'portal-body' }, el('span', { class: 'dim', text: 'Reading…' }));
    const target = fileById(block.fileId);

    const caption = el('figcaption', {
      class: 'image-caption',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Caption (optional)',
    });
    caption.textContent = block.caption ?? '';
    caption.addEventListener('input', () =>
      replace(index, { ...blocks[index], caption: caption.textContent.slice(0, 500) || null }));

    portalText(block)
      .then((lines) => {
        if (!lines.length) { mount(body, el('span', { class: 'dim', text: 'Nothing there yet.' })); return; }
        mount(body, lines.map((line) => {
          const row = el('div', { class: 'portal-line' });
          row.replaceChildren(...renderInline(line));
          return row;
        }));
      })
      .catch(() => mount(body, el('span', { class: 'dim', text: 'That page could not be read.' })));

    return el('figure', { class: 'portal-block' },
      el('button', {
        class: 'portal-head',
        title: 'Open the page this points at',
        onclick: () => navigate(`doc/${block.fileId}`),
      },
        icon('arrows-in', { size: 14 }),
        el('span', { text: target?.title ?? 'Another page' }),
        icon('arrow-square-out', { size: 12 }),
      ),
      body,
      caption,
    );
  }

  /** The lines a portal shows: one block, or the head of the page. */
  const portalCache = new Map();
  async function portalText(block) {
    if (!block.fileId) return [];
    if (!portalCache.has(block.fileId)) portalCache.set(block.fileId, api.document(block.fileId));
    const { document: other } = await portalCache.get(block.fileId);

    if (block.blockId) {
      const at = other.blocks.findIndex((b) => b.id === block.blockId);
      if (at === -1) return [];
      // A pointed-at line brings its nested children with it: a heading with
      // nothing under it is not what anyone meant to quote.
      const base = other.blocks[at].indent ?? 0;
      const out = [other.blocks[at].text ?? ''];
      for (let i = at + 1; i < other.blocks.length; i += 1) {
        const b = other.blocks[i];
        if (!['bullet', 'numbered'].includes(b.type) || (b.indent ?? 0) <= base) break;
        out.push('  '.repeat((b.indent ?? 0) - base) + (b.text ?? ''));
      }
      return out.filter((line) => line.trim());
    }
    return other.blocks.map((b) => b.text ?? '').filter((line) => line.trim()).slice(0, 12);
  }

  /**
   * Two to four columns of lines, side by side.
   *
   * A columns block holds its own text rather than slicing the page's order,
   * so moving it moves all of it and the lines inside cannot be orphaned by an
   * edit somewhere above. On a narrow window the columns stack, which is what
   * a comparison should do rather than shrink to nothing.
   */
  function renderColumns(block, index) {
    const update = (next) => { replace(index, { ...blocks[index], columns: next }); };

    const column = (col, c) => {
      const title = el('div', {
        class: 'col-title',
        contenteditable: 'plaintext-only',
        'data-placeholder': 'Heading',
      });
      title.textContent = col.title ?? '';
      title.addEventListener('input', () => {
        const next = blocks[index].columns.map((x, i) => (i === c ? { ...x, title: title.textContent.slice(0, 200) } : x));
        update(next);
      });

      const lines = (col.lines.length ? col.lines : ['']).map((line, l) => {
        const node = editable(line, 'Line', (text) => {
          const next = blocks[index].columns.map((x, i) =>
            (i === c ? { ...x, lines: x.lines.map((y, j) => (j === l ? text : y)) } : x));
          update(next);
        }, (event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          const next = blocks[index].columns.map((x, i) => {
            if (i !== c) return x;
            const copy = [...x.lines];
            copy.splice(l + 1, 0, '');
            return { ...x, lines: copy.slice(0, 200) };
          });
          update(next);
          draw();
        });
        // The lines inside a column are not blocks of the page, so the dock
        // has nothing to act on while the caret is in one.
        node.addEventListener('focus', () => { focusedId = null; drawDock(); });
        return node;
      });

      return el('div', { class: 'doc-col' },
        title,
        ...lines,
        el('button', {
          class: 'col-add', title: 'Add a line to this column',
          onclick: () => {
            const next = blocks[index].columns.map((x, i) =>
              (i === c ? { ...x, lines: [...x.lines, ''].slice(0, 200) } : x));
            update(next);
            draw();
          },
        }, icon('plus', { size: 11 })),
      );
    };

    const count = block.columns.length;
    return el('div', { class: 'columns-group' },
      el('div', { class: 'columns-block', style: { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` } },
        block.columns.map(column)),
      el('div', { class: 'table-tools' },
        el('button', {
          class: 'table-tool', title: 'Add a column',
          disabled: count >= 4,
          onclick: () => {
            if (count >= 4) { toast('Four columns is the most that still reads.', 'error'); return; }
            update([...block.columns, { title: '', lines: [''] }]);
            draw();
          },
        }, icon('columns', { size: 13 })),
        el('button', {
          class: 'table-tool danger', title: 'Remove the last column',
          disabled: count <= 2,
          onclick: () => {
            if (count <= 2) { toast('Columns need at least two of them.', 'error'); return; }
            remember();
            update(block.columns.slice(0, -1));
            draw();
          },
        }, icon('x', { size: 13 })),
      ),
    );
  }

  /**
   * A file brought into the document. The document keeps a reference, not a
   * copy — opening it goes to the reader, where the annotation tools are, and
   * anything marked up there is still marked up when you come back.
   */
  /**
   * A page of a PDF, with what was read on it.
   *
   * The quote is kept here rather than only pointed at, so the note still says
   * something when the PDF is slow to load, is missing, or is being read on a
   * device that never downloaded it — and so the passage is findable in
   * search. The margin note is the student's own half of that: the quote is
   * what the book said, the note is what they made of it.
   */
  function renderAttachment(block, index) {
    const target = fileById(block.fileId);

    const passage = (value, placeholder, field, className) => {
      const node = el('div', {
        class: className,
        contenteditable: 'plaintext-only',
        'data-placeholder': placeholder,
      });
      node.textContent = value ?? '';
      node.addEventListener('input', () => replace(index, { ...blocks[index], [field]: node.textContent || null }));
      return node;
    };

    const cardFromQuote = async () => {
      const quote = (block.quote ?? '').trim();
      if (!quote) { toast('Copy the passage in first.', 'error'); return; }
      const decks = state.files.filter((f) => f.kind === 'deck' && !f.trashed_at);
      if (!decks.length) { toast('Create a flashcard deck first.', 'error'); return; }

      const deck = dropdown({ class: 'input' }, decks.map((d) => el('option', { value: d.id, text: d.title })));
      const front = el('input', {
        class: 'input',
        value: (block.note ?? '').trim() || `${target?.title ?? 'Source'}, p${block.page}`,
        placeholder: 'What does this passage answer?',
      });
      const ok = await dialog({
        title: 'Card from this passage',
        confirmLabel: 'Make card',
        body: el('div', null,
          el('div', { class: 'field' }, el('label', { text: 'Deck' }), deck),
          el('div', { class: 'field' }, el('label', { text: 'Question' }), front),
          el('div', { class: 'sub', text: 'The passage becomes the answer, so it is asked in the words it was read in.' }),
        ),
        onConfirm: async () => {
          if (!front.value.trim()) { toast('A card needs a question.', 'error'); return false; }
          await api.createCard({ deckId: deck.value, front: front.value.trim(), back: quote, sourceFileId: fileId });
          return true;
        },
      });
      if (!ok) return;
      await loadLibrary();
      toast('Card added.');
    };

    const row = el('div', { class: 'attach-block' },
      icon(FILE_ICON[target?.kind] ?? 'file-pdf', { size: 18 }),
      el('div', { class: 'grow' },
        el('div', { class: 'name', text: target?.title ?? 'A file that is no longer here' }),
        el('div', {
          class: 'meta',
          text: target
            ? `${FILE_LABEL[target.kind] ?? 'File'} · opens in the reader${block.page > 1 ? ` at page ${block.page}` : ''}`
            : 'Removed from your library',
        }),
      ),
      target
        ? el('button', {
            class: 'pill-btn',
            // The page travels in the route, so the reader opens where the
            // link said rather than at the top of a ninety-page paper.
            onclick: () => navigate(
              target.kind === 'pdf' && block.page > 1
                ? `pdf/${target.id}/${block.page}`
                : `${target.kind}/${target.id}`,
            ),
          }, block.page > 1 ? `Open p${block.page}` : 'Open')
        : null,
      el('button', {
        class: 'pill-btn',
        title: 'What this page said, and what you made of it',
        onclick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu({ x: rect.left - 100, y: rect.bottom + 6 }, [
            {
              icon: 'quotes',
              label: block.quote ? 'Remove the passage' : 'Quote from this page',
              onSelect: () => { remember(); replace(index, { ...blocks[index], quote: block.quote ? null : '' }); draw(); },
            },
            {
              icon: 'note-pencil',
              label: block.note ? 'Remove your note' : 'Add a note beside it',
              onSelect: () => { remember(); replace(index, { ...blocks[index], note: block.note ? null : '' }); draw(); },
            },
            { sep: true },
            { icon: 'cards-three', label: 'Make a card from the passage', onSelect: () => void cardFromQuote() },
          ]);
        },
      }, icon('quotes', { size: 13 })),
      el('i', {
        class: 'ph ph-x attach-remove',
        title: 'Remove from this document',
        onclick: () => { remember(); blocks.splice(index, 1); queue(); draw(); },
      }),
    );

    // An empty string is a passage waiting to be pasted in; absent is a link
    // with no passage at all. The two have to be told apart, or asking for a
    // quote would draw nothing until something was typed into it.
    const hasQuote = block.quote !== null && block.quote !== undefined;
    const hasNote = block.note !== null && block.note !== undefined;
    const node = hasQuote || hasNote
      ? el('div', { class: 'attach-group' },
          row,
          hasQuote ? passage(block.quote, 'Paste the passage here', 'quote', 'attach-quote') : null,
          hasNote ? passage(block.note, 'What you made of it', 'note', 'attach-note') : null,
        )
      : row;

    return applyColor(node, target?.effective_color);
  }

  /**
   * A diagram, which is a canvas shown on the page.
   *
   * The document holds a reference, not a drawing, so there is exactly one
   * copy of the diagram and editing it anywhere updates it everywhere. That is
   * also why this is read-only: the canvas editor is one click away and has
   * every tool, and a second half-featured editor embedded in a paragraph
   * would only be the first place a diagram got out of step with itself.
   */
  function renderDiagram(block, index) {
    const target = fileById(block.fileId);

    const figure = el('div', { class: 'diagram-figure' },
      el('div', { class: 'diagram-note', text: target ? 'Drawing…' : 'This diagram is no longer in your library.' }),
    );

    const caption = el('figcaption', {
      class: 'image-caption',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Caption (optional)',
    });
    caption.textContent = block.caption ?? '';
    caption.addEventListener('input', () =>
      replace(index, { ...blocks[index], caption: caption.textContent.slice(0, 500) || null }));

    const node = el('figure', { class: 'diagram-block' },
      el('div', { class: 'diagram-head' },
        icon('graph', { size: 15 }),
        el('div', { class: 'name grow', text: target?.title ?? 'Missing canvas' }),
        target
          ? el('button', {
              class: 'pill-btn',
              title: 'Open this diagram in the canvas editor',
              onclick: () => navigate(`canvas/${target.id}`),
            }, 'Edit')
          : null,
        el('i', {
          class: 'ph ph-x attach-remove',
          title: 'Remove from this document',
          onclick: () => { remember(); blocks.splice(index, 1); queue(); draw(); },
        }),
      ),
      figure,
      caption,
    );

    if (target) void fillDiagram(block.fileId, figure);
    return applyColor(node, target?.effective_color);
  }

  /**
   * Canvases already loaded for this page.
   *
   * The document redraws on every keystroke, so without this a diagram would
   * re-fetch its canvas each time the line above it was edited. The cache
   * lives as long as the view does, which means reopening the document is what
   * picks up a change made in the canvas editor meanwhile.
   */
  const diagramCache = new Map();

  async function fillDiagram(fileId, figure) {
    try {
      if (!diagramCache.has(fileId)) diagramCache.set(fileId, api.canvas(fileId).then((r) => r.canvas));
      const drawn = await diagramCache.get(fileId);
      // The page may have been redrawn — or left — while this was in flight.
      if (!figure.isConnected) return;
      const preview = canvasPreview(drawn.objects);
      mount(figure, preview ?? el('div', { class: 'diagram-note', text: 'This diagram is empty. Open it to draw.' }));
    } catch {
      // A diagram that will not load is not a reason to break the document
      // around it, so it says so in place and the rest of the page stands.
      diagramCache.delete(fileId);
      if (figure.isConnected) mount(figure, el('div', { class: 'diagram-note', text: 'This diagram could not be loaded.' }));
    }
  }

  function blockClass(block) {
    if (block.type === 'heading') return `block heading h${block.level}`;
    if (block.type === 'todo') return 'block todo' + (block.done ? ' done' : '');
    if (block.type === 'code') return 'block code-wrap';
    if (block.type === 'math') return 'block math-wrap';
    if (block.type === 'table') return 'block table-wrap';
    if (block.type === 'flashcard') return 'block card-wrap';
    if (block.type === 'image') return 'block image-wrap';
    if (block.type === 'canvas') return 'block diagram-wrap';
    if (block.type === 'quote') return 'block quote-wrap';
    if (block.type === 'embed') return 'block embed-wrap';
    if (block.type === 'portal') return 'block portal-wrap';
    if (block.type === 'columns') return 'block columns-wrap';
    if (block.type === 'bullet') {
      const cdf = block.cdf ? ` cdf-${block.cdf}` : '';
      const asks = parseCard(block.text) || openCard(block.text) || isCloze(block.text);
      return 'block bullet' + cdf + (asks ? ' is-card' : '');
    }
    return `block ${block.type}`;
  }

  /**
   * A table, with its controls where the table is.
   *
   * They stay out of sight until the pointer is over the table: a permanent
   * row of buttons under every table turns a page of notes into a page of
   * buttons. Deleting is deliberately the same question asked everywhere else
   * — the table is content, and content does not disappear without one.
   */
  /**
   * The one control every line gets, in the margin.
   *
   * A rule, a code block and an image cannot take a caret, so the keyboard way
   * of removing a line — ⌘⌫ while it is focused — has never reached them: a
   * divider could be added and then only removed by deleting the lines around
   * it. This is in the gutter rather than in the flow so it costs no space, and
   * on every kind of block rather than the awkward ones, because a control that
   * appears for some lines and not others is one people stop looking for.
   */
  /** Today as `YYYY-MM-DD` in local time, which is the day the writer is in. */
  function today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /**
   * A due date said the way it would be said out loud.
   *
   * "Tomorrow" is more use than a date near at hand, and a bare date is more
   * use than "in 9 days" further out, so it changes over as the day it names
   * stops being one you can count to.
   */
  function dueLabel(due) {
    const now = today();
    if (due === now) return 'Today';
    const day = 86_400_000;
    const days = Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${now}T00:00:00`)) / day);
    if (!Number.isFinite(days)) return due;
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    if (days > 1 && days <= 6) return new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
    if (days < 0) return `${-days} days ago`;
    return new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /** Late, or due today, or neither — a finished task is none of them. */
  function dueClass(block) {
    if (block.done || !block.due) return '';
    if (block.due < today()) return 'late';
    if (block.due === today()) return 'now';
    return '';
  }

  /** The line types a line can be turned into without losing anything. */
  const TURN_INTO = [
    { spec: { type: 'paragraph' }, icon: 'text-align-left', label: 'Text' },
    { spec: { type: 'heading', level: 1 }, icon: 'text-h-one', label: 'Heading 1' },
    { spec: { type: 'heading', level: 2 }, icon: 'text-h-two', label: 'Heading 2' },
    { spec: { type: 'heading', level: 3 }, icon: 'text-h-three', label: 'Heading 3' },
    { spec: { type: 'bullet' }, icon: 'list-bullets', label: 'Bulleted list' },
    { spec: { type: 'numbered' }, icon: 'list-numbers', label: 'Numbered list' },
    { spec: { type: 'todo' }, icon: 'check-square', label: 'To-do' },
    { spec: { type: 'quote' }, icon: 'quotes', label: 'Quote' },
    { spec: { type: 'code' }, icon: 'code', label: 'Code' },
  ];

  /** Whether this kind of line is made of words, and so can become another kind. */
  const TEXTUAL = new Set(['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'quote', 'code']);

  /**
   * When a to-do is due, asked for as a day.
   *
   * A date input rather than a typed string: the format of a date is the one
   * thing nobody should have to guess, and the calendar that comes with the
   * field already knows what today is.
   */
  async function askDue(index) {
    const block = blocks[index];
    if (!block || block.type !== 'todo') return;
    const field = el('input', { class: 'input', type: 'date', value: block.due ?? '' });
    const chosen = await dialog({
      title: 'Due',
      confirmLabel: 'Save',
      body: el('div', { class: 'field' },
        el('label', { text: 'Day' }),
        field,
        el('div', { class: 'sub', text: 'Leave it empty to take the date off again.' }),
      ),
      onConfirm: () => ({ due: field.value || null }),
    });
    if (!chosen) return;
    const live = blocks[index];
    if (!live || live.type !== 'todo') return;
    remember();
    replace(index, { ...live, due: chosen.due });
    draw();
  }

  /** Marks a bullet as the thing being learnt, or as something said about it. */
  /**
   * Whether a bullet holds its children down the page or across it.
   *
   * The children are untouched either way — same lines, same order, same
   * indent — so this is a way of looking at a list rather than a change to it,
   * and turning it off is never destructive.
   */
  function setLayout(index, layout) {
    const block = blocks[index];
    if (!block || block.type !== 'bullet') return;
    remember();
    blocks[index] = { ...block, layout };
    queue();
    draw();
  }

  function setCdf(index, cdf) {
    const live = blocks[index];
    if (!live || live.type !== 'bullet') return;
    remember();
    replace(index, { ...live, cdf: live.cdf === cdf ? null : cdf });
    draw();
  }

  /**
   * One line copied so that it is a second line, not a second name.
   *
   * A fresh id, and none of the ids that point at cards: the copy's own blanks
   * and its own `front :: back` make their own cards the next time it is left.
   * Used by duplicating a line and by dropping a template in, which is the same
   * problem — lines arriving that must not answer to another line's cards.
   */
  function freshCopy(block) {
    const copy = { ...JSON.parse(JSON.stringify(block)), id: crypto.randomUUID() };
    if ('cardId' in copy) copy.cardId = null;
    if ('clozeCardIds' in copy) copy.clozeCardIds = [];
    if (copy.type === 'image') copy.masks = (copy.masks ?? []).map((m) => ({ ...m, id: crypto.randomUUID(), cardId: null }));
    return copy;
  }

  function duplicateBlock(index) {
    const live = blocks[index];
    if (!live) return;
    remember();
    const copy = freshCopy(live);
    blocks.splice(index + 1, 0, copy);
    queue();
    draw();
    focusBlock(copy.id, true);
  }

  /**
   * Everything that can be done to one line, gathered on the line itself.
   *
   * The dock acts on wherever the caret happens to be, which is the right
   * thing while writing and the wrong thing while tidying up: rearranging a
   * page means working on lines you are not typing in. This menu is addressed
   * by index, so it works on the line it is drawn beside whether or not the
   * caret is anywhere near it.
   */
  function openLineMenu(block, index, at) {
    const textual = TEXTUAL.has(block.type);
    openMenu(at, [
      textual ? { search: 'Turn into' } : null,
      textual ? { head: 'TURN INTO' } : null,
      ...(textual ? TURN_INTO.map((option) => ({
        icon: option.icon,
        label: option.label,
        onSelect: () => convert(option.spec, index),
      })) : []),

      block.type === 'bullet' ? { sep: true } : null,
      block.type === 'bullet' ? { head: 'FRAME' } : null,
      block.type === 'bullet' ? {
        icon: 'brackets-angle',
        label: block.cdf === 'concept' ? 'Not a concept' : 'Mark as a concept',
        onSelect: () => setCdf(index, 'concept'),
      } : null,
      block.type === 'bullet' ? {
        icon: 'text-indent',
        label: block.cdf === 'descriptor' ? 'Not a descriptor' : 'Mark as a descriptor',
        onSelect: () => setCdf(index, 'descriptor'),
      } : null,

      block.type === 'bullet' && childCount(index) > 1 ? {
        icon: 'columns',
        label: block.layout === 'columns' ? 'Stack the children' : 'Children side by side',
        onSelect: () => setLayout(index, block.layout === 'columns' ? 'list' : 'columns'),
      } : null,

      block.type === 'todo' ? { sep: true } : null,
      block.type === 'todo' ? {
        icon: 'calendar-blank',
        label: block.due ? `Due ${block.due}` : 'Give it a due date',
        onSelect: () => void askDue(index),
      } : null,

      { sep: true },
      { icon: 'copy', label: 'Duplicate', onSelect: () => duplicateBlock(index) },
      { icon: 'arrow-up', label: 'Move up', onSelect: () => moveBlock(index, -1) },
      { icon: 'arrow-down', label: 'Move down', onSelect: () => moveBlock(index, 1) },
      { sep: true },
      { icon: 'trash', label: 'Delete this line', danger: true, onSelect: () => void deleteBlock(index) },
    ]);
  }

  function blockHandle(block, index) {
    return el('span', { class: 'handle' },
      dragBlock(el('button', {
        title: 'Click for options · drag onto a deck or canvas',
        tabindex: '-1',
        // Pointer-down would steal the caret before the click ever landed.
        onmousedown: (event) => event.preventDefault(),
        onclick: (event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openLineMenu(block, index, { x: rect.left, y: rect.bottom + 6 });
        },
      }, icon('dots-six-vertical', { size: 13 })), () => {
        const at = blocks.findIndex((b) => b.id === block.id);
        const current = blocks[at] ?? block;
        const text = stripMarks(cardText(at) ?? current.text ?? '').trim();
        const card = parseCard(text);
        return { text, front: card?.front ?? text, back: card?.back ?? '', fileId };
      }),
    );
  }

  /**
   * Removing a line by hand.
   *
   * No confirmation: undo covers a block, and asking twice about deleting an
   * empty paragraph is how a warning stops being read. An image is the one
   * exception, because its bytes go with it and undo cannot bring those back —
   * so that path asks, and asks before anything is dropped.
   */
  async function deleteBlock(index) {
    const block = blocks[index];
    if (!block) return;

    if (block.type === 'image') {
      const ok = await confirmDelete('This image is deleted for good, and its space given back.', { confirmLabel: 'Delete image' });
      if (!ok) return;
      try { await api.deleteImage(block.imageId); }
      catch (err) { reportError(err); return; }
    }

    remember();
    blocks.splice(index, 1);
    // A page with nothing on it still needs somewhere to type.
    if (!blocks.length) blocks.push(blankBlock({ type: plainType() }));
    queue();
    draw();
  }

  /**
   * What a column can hold.
   *
   * A type is not decoration: it is what lets a column be sorted the way a
   * reader means it — 10 after 9 rather than before it, March after February
   * — and what decides which control a cell gets. `text` is the default
   * because it is the only thing a table could hold before there was a choice,
   * and an untyped table must keep reading exactly as it did.
   */
  const COLUMN_TYPES = [
    { type: 'text', icon: 'text-aa', label: 'Text' },
    { type: 'number', icon: 'hash', label: 'Number' },
    { type: 'date', icon: 'calendar-blank', label: 'Date' },
    { type: 'status', icon: 'circle-dashed', label: 'Status' },
    { type: 'link', icon: 'link-simple', label: 'Link' },
  ];

  /**
   * The states a status column moves through.
   *
   * A fixed set rather than free text, because the point of a status column is
   * that two rows saying the same thing are spelled the same way — otherwise
   * it is a text column with extra steps.
   */
  const STATUSES = ['Not started', 'Learning', 'Confident', 'Done'];

  function renderTable(block, index) {
    const named = Array.isArray(block.rowLabels);
    const cols = (named ? 'minmax(90px, 0.6fr) ' : '') + `repeat(${block.columns.length}, minmax(0, 1fr))`;
    const grid = el('div', { class: 'table-block' });
    const typeOf = (c) => block.columnTypes?.[c] ?? 'text';

    /** A column's type follows the column, so it moves and goes with it. */
    const setColumnType = (c, type) => {
      remember();
      const columnTypes = block.columns.map((_, i) => (i === c ? type : typeOf(i)));
      replace(index, { ...block, columnTypes });
      draw();
    };

    const editCell = (value, onEdit, opts = {}) => {
      const node = el('div', {
        class: 'tcell' + (opts.head ? ' head' : '') + (opts.align ? ` ${opts.align}` : ''),
        contenteditable: 'plaintext-only',
        'data-placeholder': opts.placeholder ?? '',
      });
      node.textContent = value ?? '';
      node.addEventListener('input', () => onEdit(node.textContent));
      return node;
    };

    /*
     * A cell is drawn by what its column holds. A date gets a date field
     * because the format of a date is the one thing nobody should have to
     * guess, and a status gets a fixed list because the whole use of a status
     * column is that two rows saying the same thing are spelled the same way.
     * Everything else is still text being typed, which is what a table mostly
     * is.
     */
    const cell = (value, onEdit, opts = {}) => {
      const type = opts.head ? 'text' : (opts.type ?? 'text');
      let node;

      if (type === 'date') {
        const field = el('input', {
          type: 'date', class: 'tcell tdate', value: value ?? '',
          'aria-label': opts.placeholder || 'Date',
        });
        field.addEventListener('change', () => onEdit(field.value));
        node = field;
      } else if (type === 'status') {
        const current = (value ?? '').trim();
        node = el('button', {
          class: 'tcell tstatus' + (current ? ` s${STATUSES.indexOf(current) + 1}` : ' empty'),
          title: 'Set this status',
          onmousedown: (event) => event.preventDefault(),
          onclick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom + 4 }, [
              ...STATUSES.map((name) => ({
                icon: name === current ? 'check-circle' : 'circle-dashed',
                label: name,
                onSelect: () => { onEdit(name); draw(); },
              })),
              { sep: true },
              { icon: 'x', label: 'Clear', onSelect: () => { onEdit(''); draw(); } },
            ]);
          },
        }, el('span', { text: current || 'Set' }));
      } else if (type === 'link' && isLink(value)) {
        node = el('div', { class: 'tcell-link' },
          editCell(value, onEdit, opts),
          el('a', {
            class: 'tgo', href: value.trim(), target: '_blank', rel: 'noreferrer noopener',
            title: 'Open this link', tabindex: '-1',
          }, icon('arrow-square-out', { size: 11 })),
        );
      } else {
        node = editCell(value, onEdit, { ...opts, align: type === 'number' ? 'num' : null });
      }

      // A text cell is contenteditable, so anything inside it would become part
      // of what is being typed. The remover goes in a wrapper beside it instead.
      if (!opts.strike) return node;
      return el('div', { class: 'tcell-wrap' }, node, opts.strike);
    };

    /**
     * Which rows are shown, and in what order.
     *
     * Sorting and filtering are a way of looking at the table rather than a
     * change to it: the rows keep the order they were written in, and every
     * edit still addresses the row it came from. Turning a sort off therefore
     * puts the table back exactly as it was, which is not true of a sort that
     * rewrites the rows.
     */
    const visibleRows = () => {
      let order = block.rows.map((_, r) => r);
      const filter = block.filter;
      if (filter && filter.contains.trim()) {
        const needle = filter.contains.trim().toLowerCase();
        order = order.filter((r) => String(block.rows[r]?.[filter.column] ?? '').toLowerCase().includes(needle));
      }
      const sort = block.sort;
      if (sort) {
        const type = typeOf(sort.column);
        const way = sort.direction === 'desc' ? -1 : 1;
        const key = (r) => String(block.rows[r]?.[sort.column] ?? '').trim();
        order = [...order].sort((a, b) => {
          const x = key(a);
          const y = key(b);
          // An empty cell sorts last either way round: a blank is a cell
          // nobody has filled in yet, not the smallest value in the column.
          if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
          if (type === 'number') return way * (Number(x.replace(/[^\d.\-]/g, '')) - Number(y.replace(/[^\d.\-]/g, '')));
          if (type === 'date') return way * (x < y ? -1 : x > y ? 1 : 0);
          if (type === 'status') return way * (STATUSES.indexOf(x) - STATUSES.indexOf(y));
          return way * x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
        });
      }
      return order;
    };

    /*
     * A column is removed from above it and a row from beside it, because that
     * is where each one is: hunting for the right entry in a single menu means
     * counting columns, and counting is exactly what a table is for avoiding.
     * The last of either stays put — a table with no columns is not a table.
     */
    const removeColumn = (c) => {
      if (block.columns.length <= 1) { toast('A table needs at least one column.', 'error'); return; }
      remember();
      replace(index, {
        ...block,
        columns: block.columns.filter((_, i) => i !== c),
        rows: block.rows.map((row) => row.filter((_, i) => i !== c)),
      });
      draw();
    };

    const removeRow = (r) => {
      if (block.rows.length <= 1) { toast('A table needs at least one row.', 'error'); return; }
      remember();
      const next = { ...block, rows: block.rows.filter((_, i) => i !== r) };
      // Names are a parallel array, so one has to go with its row or every
      // name below it shifts up onto the wrong line.
      if (named) next.rowLabels = block.rowLabels.filter((_, i) => i !== r);
      replace(index, next);
      draw();
    };

    const strike = (title, onPress, extra) => el('button', {
      class: `tstrike ${extra}`, title, tabindex: '-1',
      // Pointer-down inside a table would move the caret out of the cell the
      // student was editing before the click ever resolved.
      onmousedown: (event) => event.preventDefault(),
      onclick: onPress,
    }, icon('x', { size: 10 }));

    const sortBy = (c, direction) => {
      remember();
      replace(index, { ...block, sort: direction ? { column: c, direction } : null });
      draw();
    };

    const filterBy = async (c) => {
      const field = el('input', {
        class: 'input', value: block.filter?.column === c ? block.filter.contains : '',
        placeholder: 'Show rows containing…', autofocus: true,
      });
      const ok = await dialog({
        title: `Filter by \u201c${block.columns[c] || 'this column'}\u201d`,
        confirmLabel: 'Filter',
        body: el('div', { class: 'field' }, el('label', { text: 'Contains' }), field),
      });
      if (!ok) return;
      remember();
      const contains = field.value.trim().slice(0, 200);
      replace(index, { ...block, filter: contains ? { column: c, contains } : null });
      draw();
    };

    /*
     * Everything that belongs to a column, on the column. Sorting, what the
     * column holds and the filter all answer the question "what is in this
     * column", so they are asked in the same place — the alternative is a
     * toolbar of controls that each need a column named before they mean
     * anything.
     */
    const openColumnMenu = (c, at) => {
      const sorted = block.sort?.column === c ? block.sort.direction : null;
      openMenu(at, [
        { head: 'SORT' },
        { icon: 'sort-ascending', label: sorted === 'asc' ? 'Sorted A→Z' : 'Sort A→Z', onSelect: () => sortBy(c, sorted === 'asc' ? null : 'asc') },
        { icon: 'sort-descending', label: sorted === 'desc' ? 'Sorted Z→A' : 'Sort Z→A', onSelect: () => sortBy(c, sorted === 'desc' ? null : 'desc') },
        { sep: true },
        { head: 'HOLDS' },
        ...COLUMN_TYPES.map((option) => ({
          icon: option.type === typeOf(c) ? 'check-circle' : option.icon,
          label: option.label,
          onSelect: () => setColumnType(c, option.type),
        })),
        { sep: true },
        { icon: 'funnel', label: block.filter?.column === c ? 'Change the filter…' : 'Filter by this column…', onSelect: () => void filterBy(c) },
        block.filter ? { icon: 'funnel-simple', label: 'Clear the filter', onSelect: () => { remember(); replace(index, { ...block, filter: null }); draw(); } } : null,
        block.columns.length > 1 ? { sep: true } : null,
        block.columns.length > 1 ? { icon: 'trash', label: 'Delete this column', danger: true, onSelect: () => removeColumn(c) } : null,
      ].filter(Boolean));
    };

    const headCell = (col, c) => {
      const sorted = block.sort?.column === c ? block.sort.direction : null;
      const name = cell(col, (text) => {
        const columns = [...block.columns];
        columns[c] = text;
        replace(index, { ...block, columns });
      }, { head: true, placeholder: 'Column' });

      return el('div', { class: 'tcell-wrap thead-wrap' },
        name,
        el('button', {
          class: 'tcol-menu' + (sorted || block.filter?.column === c ? ' on' : ''),
          title: `${COLUMN_TYPES.find((t) => t.type === typeOf(c))?.label ?? 'Text'} column — sort, filter or change what it holds`,
          tabindex: '-1',
          onmousedown: (event) => event.preventDefault(),
          onclick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openColumnMenu(c, { x: rect.left - 120, y: rect.bottom + 6 });
          },
        }, icon(sorted === 'asc' ? 'sort-ascending' : sorted === 'desc' ? 'sort-descending' : 'caret-up-down', { size: 11 })),
        block.columns.length > 1 ? strike('Delete this column', () => removeColumn(c), 'tstrike-col') : null,
      );
    };

    grid.appendChild(el('div', { class: 'trow head-row', style: { gridTemplateColumns: cols } },
      named ? el('div', { class: 'tcell head corner' }) : null,
      block.columns.map((col, c) => headCell(col, c)),
    ));

    const order = visibleRows();
    for (const r of order) {
      const row = block.rows[r] ?? [];
      grid.appendChild(el('div', { class: 'trow', style: { gridTemplateColumns: cols } },
        block.rows.length > 1 ? strike('Delete this row', () => removeRow(r), 'tstrike-row') : null,
        named
          ? cell(block.rowLabels[r] ?? '', (text) => {
              const rowLabels = [...(block.rowLabels ?? [])];
              while (rowLabels.length < block.rows.length) rowLabels.push('');
              rowLabels[r] = text;
              replace(index, { ...block, rowLabels });
            }, { head: true, placeholder: 'Row' })
          : null,
        block.columns.map((_, c) => cell(row[c] ?? '', (text) => {
          const rows = block.rows.map((existing) => [...existing]);
          while (rows[r].length < block.columns.length) rows[r].push('');
          rows[r][c] = text;
          replace(index, { ...block, rows });
        }, { type: typeOf(c) })),
      ));
    }

    // A filtered table says so, because a row that is not on screen still
    // exists — and the quickest way back to the whole table should be beside
    // the reason it is not showing.
    if (block.filter && block.rows.length !== order.length) {
      grid.appendChild(el('div', { class: 'tfilter-note' },
        icon('funnel', { size: 12 }),
        el('span', { text: `${block.columns[block.filter.column] || 'Column'} contains \u201c${block.filter.contains}\u201d · ${block.rows.length - order.length} hidden` }),
        el('button', { class: 'link', text: 'Show all', onclick: () => { remember(); replace(index, { ...block, filter: null }); draw(); } }),
      ));
    }

    const tool = (glyph, title, onPress, opts = {}) => el('button', {
      class: 'table-tool' + (opts.danger ? ' danger' : '') + (opts.on ? ' on' : ''),
      title,
      onclick: onPress,
    }, icon(glyph, { size: 13 }));

    const addRow = () => {
      const next = { ...block, rows: [...block.rows, new Array(block.columns.length).fill('')] };
      if (named) next.rowLabels = [...block.rowLabels, ''];
      replace(index, next);
      draw();
    };

    const addColumn = () => {
      if (block.columns.length >= 20) { toast('A table may have at most 20 columns.', 'error'); return; }
      replace(index, {
        ...block,
        columns: [...block.columns, 'Column'],
        rows: block.rows.map((r) => [...r, '']),
      });
      draw();
    };

    /* Row names are off by default: a table of two columns and three rows does
       not need a header down its side, and an empty one is worse than none. */
    const toggleRowNames = () => {
      replace(index, {
        ...block,
        rowLabels: named ? null : block.rows.map((_, r) => block.rowLabels?.[r] ?? ''),
      });
      draw();
    };

    /**
     * Every row of the table, asked as a question.
     *
     * A revision table is already a deck written out flat — a term beside its
     * meaning, a date beside its event — so the honest thing is to read it as
     * one rather than make the student type it twice. Which column asks and
     * which answers is theirs to say, because a table is written to be read in
     * whichever direction suits it.
     */
    const cardsFromTable = async () => {
      const decks = state.files.filter((f) => f.kind === 'deck' && !f.trashed_at);
      if (!decks.length) { toast('Create a flashcard deck first.', 'error'); return; }

      const choices = [
        ...(named ? [{ value: 'row', label: 'Row name' }] : []),
        ...block.columns.map((col, c) => ({ value: String(c), label: col || `Column ${c + 1}` })),
      ];
      const column = (id, selected) => dropdown({ class: 'input', id },
        choices.map((choice) => el('option', { value: choice.value, text: choice.label, selected: choice.value === selected })),
      );
      const deck = dropdown({ class: 'input' }, decks.map((d) => el('option', { value: d.id, text: d.title })));
      const front = column('tbl-front', named ? 'row' : '0');
      const back = column('tbl-back', named ? '0' : '1');

      const side = (r, which) => (which === 'row'
        ? (block.rowLabels?.[r] ?? '')
        : (block.rows[r]?.[Number(which)] ?? '')).trim();

      let made = 0;
      const ok = await dialog({
        title: 'Cards from this table',
        confirmLabel: 'Make cards',
        body: el('div', null,
          el('div', { class: 'field' }, el('label', { text: 'Deck' }), deck),
          el('div', { class: 'field' }, el('label', { text: 'Question' }), front),
          el('div', { class: 'field' }, el('label', { text: 'Answer' }), back),
          el('div', { class: 'sub', text: 'One card per row. Rows hidden by a filter are left out, and a row missing either side is skipped.' }),
        ),
        onConfirm: async () => {
          if (front.value === back.value) { toast('A card needs two different columns.', 'error'); return false; }
          const pairs = visibleRows()
            .map((r) => ({ front: side(r, front.value), back: side(r, back.value) }))
            .filter((pair) => pair.front && pair.back);
          if (!pairs.length) { toast('No row has both a question and an answer.', 'error'); return false; }
          for (const pair of pairs) {
            await api.createCard({ deckId: deck.value, front: pair.front, back: pair.back, sourceFileId: fileId });
          }
          made = pairs.length;
          return true;
        },
      });
      if (!ok) return;
      await loadLibrary();
      toast(`${plural(made, 'card')} added.`);
    };

    const removeTable = async () => {
      const ok = await confirmDelete('This table and everything in it.', { confirmLabel: 'Delete table' });
      if (!ok) return;
      remember();
      blocks.splice(index, 1);
      if (!blocks.length) blocks.push(blankBlock({ type: plainType() }));
      queue();
      draw();
    };

    return el('div', { class: 'table-group' },
      grid,
      el('div', { class: 'table-tools' },
        tool('rows', 'Add a row', addRow),
        tool('columns', 'Add a column', addColumn),
        tool('text-align-left', named ? 'Stop naming rows' : 'Name the rows', toggleRowNames, { on: named }),
        tool('cards-three', 'Make cards from this table', () => void cardsFromTable()),
        block.filter
          ? tool('funnel', 'Clear the filter', () => { remember(); replace(index, { ...block, filter: null }); draw(); }, { on: true })
          : null,
        block.sort
          ? tool('arrows-down-up', 'Stop sorting', () => { remember(); replace(index, { ...block, sort: null }); draw(); }, { on: true })
          : null,
        tool('trash', 'Delete this table', removeTable, { danger: true }),
      ),
    );
  }

  /**
   * A picture, with the parts of it that are covered over.
   *
   * The bytes belong to this document rather than to the library — an image is
   * not something you open on its own — so removing it here is what frees the
   * space, and the block is only dropped once the server has agreed.
   *
   * The masks are the point of the block rather than a decoration on it: a
   * labelled diagram is the thing a student is actually tested on, and the
   * honest way to test it is to hide a label and ask for it back. They are
   * kept as fractions of the picture, so the same diagram works at any width,
   * and the picture itself is never altered — uncovering is a matter of not
   * drawing a box, so nothing can be lost by covering something up.
   */
  function renderImage(block, index) {
    const figure = el('figure', { class: 'image-block' });
    const img = el('img', {
      src: api.imageContentUrl(block.imageId),
      alt: block.alt ?? '',
      loading: 'lazy',
      draggable: 'false',
    });
    img.addEventListener('error', () => {
      mount(figure, el('div', { class: 'image-missing' },
        icon('image-broken', { size: 18 }), 'This image is no longer here.'));
    });

    const caption = el('figcaption', {
      class: 'image-caption',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Caption (optional)',
    });
    caption.textContent = block.caption ?? '';
    caption.addEventListener('input', () => replace(index, { ...block, caption: caption.textContent.slice(0, 500) }));

    /* ── occlusion ─────────────────────────────────────────────────── */

    const masks = Array.isArray(block.masks) ? [...block.masks] : [];
    let editing = false;
    const layer = el('div', { class: 'mask-layer' });
    const draft = el('div', { class: 'mask-draft hidden' });

    const commit = () => {
      // The block can have been deleted while a label dialog was open.
      const live = blocks[index];
      if (!live || live.type !== 'image') return;
      remember();
      replace(index, { ...live, masks: [...masks] });
      drawMasks();
    };

    /** A mask's box as CSS, from the fractions it is stored as. */
    const boxStyle = (mask) => ({
      left: `${mask.x * 100}%`,
      top: `${mask.y * 100}%`,
      width: `${mask.width * 100}%`,
      height: `${mask.height * 100}%`,
    });

    async function labelMask(at) {
      const mask = masks[at];
      if (!mask) return;
      const field = el('input', { class: 'input', value: mask.label ?? '', placeholder: 'What is under here?', autofocus: true });
      const label = await dialog({
        title: 'Label this area',
        confirmLabel: 'Save',
        body: el('div', { class: 'field' },
          el('label', { text: 'Answer' }),
          field,
          el('div', { class: 'sub', text: 'Used as the answer when this diagram is tested. Leave it empty to only hide the area.' }),
        ),
        onConfirm: () => field.value.trim().slice(0, 200),
      });
      if (label === null || label === undefined) return;
      masks[at] = { ...mask, label: label || null };
      commit();
    }

    function drawMasks() {
      mount(layer,
        ...masks.map((mask, at) => el('button', {
          class: 'mask',
          style: boxStyle(mask),
          title: editing
            ? (mask.label ? `“${mask.label}” — click to edit` : 'Unlabelled — click to edit')
            : (mask.label ? 'Click to uncover' : 'Click to uncover'),
          onclick: (event) => {
            event.stopPropagation();
            if (!editing) { event.currentTarget.classList.toggle('open'); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom + 6 }, [
              { icon: 'text-aa', label: mask.label ? 'Change the answer' : 'Add the answer', onSelect: () => void labelMask(at) },
              { sep: true },
              {
                icon: 'trash', label: 'Uncover this area', danger: true,
                onSelect: () => { masks.splice(at, 1); commit(); },
              },
            ]);
          },
        }, el('span', { class: 'mask-num', text: `${at + 1}` }))),
        draft,
      );
    }

    // Drawing a new mask. The box follows the pointer live rather than
    // appearing on release, because a cover you cannot see the edges of while
    // placing it is a cover you place twice.
    layer.addEventListener('pointerdown', (event) => {
      if (!editing || event.button !== 0 || event.target !== layer) return;
      event.preventDefault();
      const frame = layer.getBoundingClientRect();
      if (frame.width < 4 || frame.height < 4) return;
      const clamp = (n) => Math.max(0, Math.min(1, n));
      const x0 = clamp((event.clientX - frame.left) / frame.width);
      const y0 = clamp((event.clientY - frame.top) / frame.height);
      layer.setPointerCapture(event.pointerId);

      const move = (moved) => {
        const x1 = clamp((moved.clientX - frame.left) / frame.width);
        const y1 = clamp((moved.clientY - frame.top) / frame.height);
        draft.hidden = false;
        Object.assign(draft.style, boxStyle({
          x: Math.min(x0, x1), y: Math.min(y0, y1),
          width: Math.abs(x1 - x0), height: Math.abs(y1 - y0),
        }));
      };

      const up = (ended) => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        layer.removeEventListener('pointercancel', up);
        draft.hidden = true;
        const x1 = clamp((ended.clientX - frame.left) / frame.width);
        const y1 = clamp((ended.clientY - frame.top) / frame.height);
        const width = Math.abs(x1 - x0);
        const height = Math.abs(y1 - y0);
        // A stray click is not a mask. Anything under about a hundredth of the
        // picture each way is one, and the schema will not take it either.
        if (width < 0.01 || height < 0.01) return;
        if (masks.length >= 60) { toast('That is as many covered areas as one picture can hold.', 'error'); return; }
        masks.push({
          id: crypto.randomUUID(),
          x: Math.min(x0, x1), y: Math.min(y0, y1),
          width, height, label: null, cardId: null,
        });
        commit();
        void labelMask(masks.length - 1);
      };

      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
      layer.addEventListener('pointercancel', up);
    });

    const occludeBtn = el('button', {
      class: 'table-tool image-occlude',
      title: 'Cover parts of this picture to test yourself on them',
      onclick: () => {
        editing = !editing;
        occludeBtn.classList.toggle('on', editing);
        layer.classList.toggle('editing', editing);
        if (editing) toast('Drag across the picture to cover a label.');
        drawMasks();
      },
    }, icon('selection-plus', { size: 13 }));

    drawMasks();

    // The covers above test a diagram while the page is open; this turns them
    // into scheduled cards in a deck. The picture is copied into the deck the
    // first time, so the cards survive this page, and the copy is reused after
    // that, so remaking the cards updates them instead of duplicating them.
    const cardsBtn = el('button', {
      class: 'table-tool image-cards',
      title: 'Make scheduled flashcards from the covered labels',
      onclick: async () => {
        const live = blocks[index];
        if (!live || live.type !== 'image') return;
        const known = live.occlusionDeckId && fileById(live.occlusionDeckId) && live.occlusionImageId;
        const result = await openOcclusionEditor({
          ...(known
            ? { imageId: live.occlusionImageId, deckId: live.occlusionDeckId }
            : { url: api.imageContentUrl(live.imageId) }),
          masks: masks.map((m) => ({ ...m, label: m.label ?? '' })),
          sourceFileId: fileId,
          title: known ? 'Update diagram cards' : 'Make cards from this diagram',
        });
        const data = readOcclusion(result?.cards?.[0]);
        if (!data) return;
        masks.splice(0, masks.length, ...data.masks.map((m) => ({
          id: m.id, x: m.x, y: m.y, width: m.width, height: m.height, label: m.label ?? null, cardId: null,
        })));
        remember();
        replace(index, {
          ...blocks[index], masks: [...masks],
          occlusionDeckId: result.cards[0].deck_id, occlusionImageId: data.imageId,
        });
        drawMasks();
        void loadLibrary();
      },
    }, icon('cards', { size: 13 }));

    figure.appendChild(el('div', { class: 'image-frame' },
      img,
      layer,
      occludeBtn,
      cardsBtn,
      el('button', {
        class: 'table-tool danger image-remove',
        title: 'Remove this image',
        onclick: async () => {
          const ok = await confirmDelete('This image is deleted for good, and its space given back.', { confirmLabel: 'Delete image' });
          if (!ok) return;
          try { await api.deleteImage(block.imageId); }
          catch (err) { reportError(err); return; }
          remember();
          blocks.splice(index, 1);
          if (!blocks.length) blocks.push(blankBlock({ type: plainType() }));
          queue();
          draw();
        },
      }, icon('trash', { size: 13 })),
    ));
    figure.appendChild(caption);
    return figure;
  }

  /**
   * An equation: LaTeX on one side, the typeset result on the other.
   *
   * Both are on screen at once rather than behind a toggle. Maths is written
   * by looking at what came out — a misplaced brace is invisible in the source
   * and obvious in the rendering — so hiding either half turns writing an
   * equation into a guessing game. The source pane fades out when the
   * equation is not being edited, so a finished page reads as typeset maths.
   */
  function renderEquation(block, index) {
    const output = el('div', { class: 'math-output' });
    const source = el('div', {
      class: 'btext math-source',
      contenteditable: 'plaintext-only',
      spellcheck: 'false',
      'data-placeholder': String.raw`\frac{a}{b} = c`,
    });
    source.textContent = block.latex ?? '';

    // Redrawn as it is typed, not on blur: the rendering is the feedback.
    const paint = () => renderMath(output, source.textContent, { display: true });
    paint();

    source.addEventListener('input', () => {
      replace(index, { ...blocks[index], latex: source.textContent.slice(0, 4000) });
      paint();
    });
    source.addEventListener('focus', () => {
      focusedId = block.id;
      drawDock();
      // Pulled in now so the first keystroke is not the one that waits for a
      // 272 KB download.
      loadKatex().catch(() => {});
    });

    const caption = el('figcaption', {
      class: 'image-caption',
      contenteditable: 'plaintext-only',
      'data-placeholder': 'Caption (optional)',
    });
    caption.textContent = block.caption ?? '';
    caption.addEventListener('input', () =>
      replace(index, { ...blocks[index], caption: caption.textContent.slice(0, 500) || null }));

    return el('figure', { class: 'math-block' }, output, source, caption);
  }

  function renderFlashcard(block, index) {
    let flipped = false;
    const back = el('div', { class: 'back', text: block.back || 'Add the answer' });

    const node = el('div', { class: 'card-block' },
      el('div', { class: 'kicker' }, icon('cards', { size: 14 }), 'FLASHCARD · IN THIS DOC'),
      (() => {
        const front = el('div', { class: 'front', contenteditable: 'plaintext-only', 'data-placeholder': 'Question' });
        front.textContent = block.front;
        front.addEventListener('input', () => replace(index, { ...block, front: front.textContent }));
        return front;
      })(),
      (() => {
        back.setAttribute('contenteditable', 'plaintext-only');
        back.textContent = block.back;
        back.addEventListener('input', () => replace(index, { ...block, back: back.textContent }));
        return back;
      })(),
      el('div', { class: 'acts' },
        el('button', {
          class: 'btn primary',
          text: block.cardId ? 'In deck' : 'Add to deck',
          disabled: Boolean(block.cardId),
          onclick: () => addCardToDeck(block, index),
        }),
        el('button', { class: 'btn', text: 'Flip', onclick: () => { flipped = !flipped; back.style.opacity = flipped ? '0.25' : '1'; } }),
      ),
    );
    return node;
  }

  async function addCardToDeck(block, index) {
    const decks = state.files.filter((f) => f.kind === 'deck');
    if (!decks.length) { toast('Create a flashcard deck first.', 'error'); return; }

    const select = dropdown({ class: 'input' }, decks.map((d) => el('option', { value: d.id, text: d.title })));
    const ok = await dialog({
      title: 'Add to deck',
      confirmLabel: 'Add card',
      body: el('div', { class: 'field' }, el('label', { text: 'Deck' }), select),
      onConfirm: async () => {
        if (!block.front.trim() || !block.back.trim()) { toast('A card needs both a question and an answer.', 'error'); return false; }
        const { card } = await api.createCard({
          deckId: select.value,
          front: block.front,
          back: block.back,
          sourceFileId: fileId,
        });
        replace(index, { ...block, cardId: card.id });
        return true;
      },
    });
    if (ok) { await save(); await loadLibrary(); draw(); toast('Card added.'); }
  }

  /* ── testing this page ─────────────────────────────────────────────── */

  /**
   * Everything on this page that can be asked as a question.
   *
   * Gathered from what is already written rather than from a separate store,
   * so a page is testable the moment it is worth testing and there is nothing
   * to keep in step. Four things qualify: a flashcard block, a line written as
   * `front :: back`, a `{blank}` in a sentence, and a labelled cover on a
   * picture. Anything else on the page is prose, and prose has no answer.
   */
  function quizItems() {
    const out = [];
    for (const block of blocks) {
      if (block.type === 'flashcard') {
        const front = (block.front ?? '').trim();
        const back = (block.back ?? '').trim();
        if (front && back) out.push({ kind: 'text', front, back });
        continue;
      }

      if (block.type === 'image') {
        for (const mask of block.masks ?? []) {
          if (!mask.label) continue;
          out.push({ kind: 'mask', block, mask, back: mask.label });
        }
        continue;
      }

      const text = block.text ?? '';
      if (!text.trim()) continue;

      const card = parseCard(text);
      if (card) out.push({ kind: 'text', front: stripMarks(card.front), back: stripMarks(card.back) });

      const blanks = inlineClozes(text);
      for (let i = 0; i < blanks.length; i += 1) {
        const front = stripMarks(clozeQuestion(text, i)).trim();
        if (front && blanks[i].trim()) out.push({ kind: 'text', front, back: stripMarks(blanks[i]).trim() });
      }

      // A `{{c1::…}}` cloze asks one question per group, the tested words its
      // answer, so the whole-page quiz sees the same faces the review loop does.
      if (isCloze(text)) {
        for (const g of clozeGroups(text)) {
          const face = clozeFace(text, g);
          const front = stripMarks(face.question).trim();
          const back = stripMarks(face.tested || face.answer).trim();
          if (front && back) out.push({ kind: 'text', front, back });
        }
      }
    }
    return out;
  }

  /** A picture with its covers on, one of them the one being asked about. */
  function maskFigure(item, revealed) {
    const frame = el('div', { class: 'image-frame quiz-figure' },
      el('img', { src: api.imageContentUrl(item.block.imageId), alt: item.block.alt ?? '', draggable: 'false' }),
      el('div', { class: 'mask-layer' }, (item.block.masks ?? []).map((mask) => {
        const asked = mask.id === item.mask.id;
        return el('span', {
          class: 'mask' + (asked ? ' asked' : '') + (asked && revealed ? ' open' : ''),
          style: {
            left: `${mask.x * 100}%`, top: `${mask.y * 100}%`,
            width: `${mask.width * 100}%`, height: `${mask.height * 100}%`,
          },
        }, asked ? el('span', { class: 'mask-num', text: '?' }) : null);
      })),
    );
    return frame;
  }

  /**
   * The page, asked back.
   *
   * Deliberately not scheduled: this is the read-through-then-check that
   * happens while the notes are still open, and pretending it were a review
   * session would put half a page of half-written cards into the schedule at
   * the worst possible moment. The cards made deliberately — with the card
   * tag, or `⌘⇧C` — are the ones that are scheduled.
   */
  function toggleQuiz() {
    quizOpen = !quizOpen;
    quiz.classList.toggle('hidden', !quizOpen);
    if (!quizOpen) { mount(quiz); return; }

    const items = quizItems();
    if (!items.length) {
      quizOpen = false;
      quiz.classList.add('hidden');
      toast('Nothing on this page can be asked back yet. Write a card with :: , a {blank}, or cover a label on a picture.');
      return;
    }

    // Shuffled, because the order the notes were written in is a hint: the
    // answer to the line above is half the answer to the line below.
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }

    let at = 0;
    let shown = false;
    let right = 0;

    const close = () => { quizOpen = false; quiz.classList.add('hidden'); mount(quiz); };

    function step() {
      if (at >= items.length) {
        mount(quiz, el('div', { class: 'quiz-card' },
          el('div', { class: 'quiz-count', text: 'Done' }),
          el('div', { class: 'q', text: `${right} of ${items.length} right.` }),
          el('div', { class: 'quiz-rate' },
            el('button', { class: 'btn', text: 'Close', onclick: close }),
            el('button', { class: 'btn primary', text: 'Again', onclick: () => { at = 0; right = 0; shown = false; step(); } }),
          ),
        ));
        return;
      }

      const item = items[at];
      mount(quiz, el('div', { class: 'quiz-card' },
        el('div', { class: 'quiz-head' },
          el('span', { class: 'quiz-count grow', text: `${at + 1} of ${items.length}` }),
          el('button', { class: 'table-tool', title: 'Close this test', onclick: close }, icon('x', { size: 13 })),
        ),
        item.kind === 'mask'
          ? maskFigure(item, shown)
          : el('div', { class: 'q', text: item.front }),
        shown ? el('div', { class: 'a', text: item.back }) : null,
        el('div', { class: 'quiz-rate' }, shown
          ? [
              el('button', { class: 'btn', text: 'Not yet', onclick: () => { at += 1; shown = false; step(); } }),
              el('button', { class: 'btn primary', text: 'Got it', onclick: () => { at += 1; right += 1; shown = false; step(); } }),
            ]
          : el('button', { class: 'btn primary', text: 'Show the answer', onclick: () => { shown = true; step(); } })),
      ));
    }

    step();
  }

  function openBlockMenu(x, y, choose) {
    openMenu({ x, y }, [
      // Twenty blocks is more than anyone reads through. The field turns the
      // `/` that opened the menu into the start of a word: `/quo` then Enter.
      { search: 'Filter blocks' },
      { head: 'BLOCKS' },
      ...BLOCK_TYPES.map((spec) => ({
        icon: spec.icon,
        label: spec.label,
        keywords: spec.keywords,
        // An image has to exist before a block can point at one, so this opens
        // the picker instead of dropping an empty frame on the page. A link to
        // a PDF is the same: the file it points at has to be chosen first, and
        // so does the page a portal looks through.
        onSelect: () => {
          if (spec.type === 'image') return pickImage();
          if (spec.type === 'pdf') return linkPdf();
          if (spec.type === 'canvas') return insertDiagram();
          if (spec.type === 'portal') return linkPortal();
          if (spec.type === 'template') return insertTemplate();
          return choose(spec);
        },
      })),
    ]);
  }

  /* ── mount ─────────────────────────────────────────────────────────── */

  /** Text this document can absorb outright, rather than link to. */
  const TEXT_TYPES = /\.(txt|md|markdown|text|docx|html?)$/i;
  /** The four every browser draws. The server checks the bytes, not the name. */
  const IMAGE_TYPES = /\.(png|jpe?g|gif|webp)$/i;

  /**
   * Bringing an outside file into the document.
   *
   * Two different things, and which one happens depends on what the file is.
   * Text becomes part of the page — appended as real lines you can then edit,
   * indent and turn into cards, because that is what you wanted it for. A PDF
   * cannot become lines, so it is added to the library and referenced from
   * here, which keeps its own annotations working.
   */
  async function importIntoDocument() {
    const picker = el('input', {
      type: 'file',
      accept: '.txt,.md,.markdown,.text,.docx,.html,.htm,.png,.jpg,.jpeg,.gif,.webp,application/pdf,text/plain,text/markdown,text/html,image/*',
      class: 'hidden',
    });
    document.body.appendChild(picker);
    picker.addEventListener('change', async () => {
      const chosen = picker.files?.[0];
      picker.remove();
      if (!chosen) return;

      if (IMAGE_TYPES.test(chosen.name) || chosen.type.startsWith('image/')) {
        await attachImage(chosen);
        return;
      }
      if (TEXT_TYPES.test(chosen.name) || chosen.type.startsWith('text/') || isImportableDocument(chosen)) {
        await appendText(chosen);
        return;
      }
      if (chosen.type === 'application/pdf' || /\.pdf$/i.test(chosen.name)) {
        await attachPdf(chosen);
        return;
      }
      toast('That kind of file cannot be brought into a document yet.', 'error');
    });
    picker.click();
  }

  /** The image picker on its own, for the toolbar and the slash menu. */
  function pickImage() {
    const picker = el('input', {
      type: 'file',
      accept: '.png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp',
      class: 'hidden',
    });
    document.body.appendChild(picker);
    picker.addEventListener('change', async () => {
      const chosen = picker.files?.[0];
      picker.remove();
      if (chosen) await attachImage(chosen);
    });
    picker.click();
  }

  /**
   * Uploads an image and places it on the page.
   *
   * It goes in after the line the caret was in, so it lands where the writer
   * was working rather than at the end of a page they may be nowhere near.
   */
  async function attachImage(chosen) {
    const form = new FormData();
    form.append('file', chosen, chosen.name);

    toast(`Uploading ${chosen.name}…`);
    let image;
    try { ({ image } = await api.uploadImage(fileId, form)); }
    catch (err) { reportError(err); return; }

    remember();
    const at = blocks.findIndex((b) => b.id === focusedId);
    const block = {
      id: crypto.randomUUID(),
      type: 'image',
      imageId: image.id,
      alt: chosen.name.replace(/\.[^.]+$/, '').slice(0, 500),
      caption: null,
    };
    blocks.splice(at === -1 ? blocks.length : at + 1, 0, block);
    queue();
    // Saved straight away: the bytes are already on the server, and a block
    // that has not been written down yet would leave them referenced by
    // nothing if the window went away.
    await save();
    draw();
  }

  /** Reads a text file and appends it as ordinary lines. */
  async function appendText(chosen) {
    // Read with the same importer as a file dropped on the window, so Word
    // headings, lists and HTML pages arrive as the lines they were, not as
    // raw markup or a zip read as text.
    let incoming;
    try { incoming = await fileToBlocks(chosen); }
    catch (err) { reportError(err); return; }
    if (!incoming.length) { toast('That file has nothing in it to append.'); return; }

    // A file with more lines than a document may hold would be truncated
    // silently, which is worse than saying so.
    const room = 5_000 - blocks.length;
    if (room <= 0) { toast('This document is already full.', 'error'); return; }
    const taken = incoming.slice(0, room);
    if (taken.length < incoming.length) toast(`Only the first ${taken.length} lines fit.`);

    remember();
    for (const block of taken) blocks.push(block);
    queue();
    draw();
    toast(`${plural(taken.length, 'line')} appended from “${chosen.name}”.`);
  }

  /**
   * Links a PDF the library already holds.
   *
   * Attaching one meant uploading it, which is the wrong half of the problem
   * for someone whose lecture notes and whose slides are both already in
   * Studex: the two could not be joined up without a second copy of the slides
   * on disk. This points at the one that is there, and the link opens the
   * reader at the page that was chosen — so a line of notes can say which page
   * of the paper it is about.
   */
  async function linkPdf() {
    const pdfs = state.files.filter((f) => f.kind === 'pdf' && !f.trashed_at);
    if (!pdfs.length) {
      toast('There are no PDFs in your library to link to yet.', 'error');
      return;
    }

    // The document's own folder first: a PDF filed beside these notes is far
    // more likely to be the one meant than one from another subject.
    const here = file.folder_id;
    const ordered = [...pdfs].sort((a, b) => {
      const mine = Number(b.folder_id === here) - Number(a.folder_id === here);
      return mine || a.title.localeCompare(b.title);
    });

    const select = dropdown({ class: 'input' }, ordered.map((pdf) => el('option', {
      value: pdf.id,
      text: pdf.folder_id === here ? pdf.title : `${pdf.title} — ${folderById(pdf.folder_id)?.name ?? 'Library'}`,
    })));
    const page = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1' });

    const chosen = await dialog({
      title: 'Link a PDF',
      confirmLabel: 'Link',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        el('div', { class: 'field' }, el('label', { text: 'PDF' }), select),
        el('div', { class: 'field' },
          el('label', { text: 'Opens at page' }),
          page,
        ),
      ),
      onConfirm: () => ({
        fileId: select.value,
        // A page number that is not one opens the document at its beginning,
        // which is what a reader would expect from a link with nothing useful
        // in that field.
        page: Math.max(1, Math.min(10_000, Math.floor(Number(page.value)) || 1)),
      }),
    });
    if (!chosen) return;

    remember();
    const at = blocks.findIndex((b) => b.id === focusedId);
    const block = { id: crypto.randomUUID(), type: 'pdf', fileId: chosen.fileId, page: chosen.page };
    blocks.splice(at === -1 ? blocks.length : at + 1, 0, block);
    queue();
    await save();
    draw();
  }

  /**
   * Puts a portal on the page.
   *
   * A portal shows another page's lines here, live: edit them there and they
   * change here, because there is only ever one copy. That is the whole point
   * of it — the alternative is pasting, and a pasted definition is wrong the
   * moment the original is corrected.
   */
  /**
   * Starting a page that has been started before.
   *
   * Two sources, one picker, because from where you are sitting they are the
   * same thing: the starters below, and any page you have already written —
   * the second being how a template that is particular to one subject or one
   * teacher comes about, since a page that is the right shape already is a
   * better template than one described in this file.
   *
   * The lines land after the caret rather than replacing the page, so a
   * template can be dropped into the middle of notes already under way.
   */
  async function insertTemplate() {
    const docs = state.files.filter((f) => f.kind === 'doc' && !f.trashed_at && f.id !== fileId);
    const here = file.folder_id;
    const ordered = [...docs].sort((a, b) => {
      const mine = Number(b.folder_id === here) - Number(a.folder_id === here);
      return mine || a.title.localeCompare(b.title);
    });

    const select = dropdown({ class: 'input' },
      el('optgroup', { label: 'Starters' }, TEMPLATES.map((t) => el('option', { value: `starter:${t.id}`, text: t.label }))),
      ordered.length
        ? el('optgroup', { label: 'A page of mine' }, ordered.map((doc) => el('option', {
          value: `page:${doc.id}`,
          text: doc.folder_id === here ? doc.title : `${doc.title} — ${folderById(doc.folder_id)?.name ?? 'Library'}`,
        })))
        : null,
    );

    const note = el('div', { class: 'sub', text: TEMPLATES[0].note });
    select.addEventListener('change', () => {
      const starter = TEMPLATES.find((t) => `starter:${t.id}` === select.value);
      note.textContent = starter
        ? starter.note
        : 'Every line of that page, copied in. Nothing there changes, and the copies make their own cards.';
    });

    const chosen = await dialog({
      title: 'Start from a template',
      confirmLabel: 'Insert',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        el('div', { class: 'field' }, el('label', { text: 'Template' }), select),
        note,
      ),
      onConfirm: () => select.value,
    });
    if (!chosen) return;

    let incoming = [];
    if (chosen.startsWith('starter:')) {
      const starter = TEMPLATES.find((t) => t.id === chosen.slice('starter:'.length));
      if (!starter) return;
      incoming = templateBlocks(starter);
    } else {
      try {
        const { document: source } = await api.document(chosen.slice('page:'.length));
        // A portal is the block for showing another page's lines as they are
        // written there. A template is the opposite: these lines are yours from
        // the moment they land, so the transcluding blocks are left behind.
        incoming = source.blocks.filter((b) => b.type !== 'portal').map(freshCopy);
      } catch (error) {
        reportError(error);
        return;
      }
    }
    if (!incoming.length) {
      toast('There is nothing on that page to copy.', 'error');
      return;
    }

    remember();
    const at = blocks.findIndex((b) => b.id === focusedId);
    blocks.splice(at === -1 ? blocks.length : at + 1, 0, ...incoming);
    queue();
    await save();
    draw();
    focusBlock(incoming[0].id, true);
    toast(`${plural(incoming.length, 'line')} added.`);
  }

  async function linkPortal() {
    const docs = state.files.filter((f) => f.kind === 'doc' && !f.trashed_at && f.id !== fileId);
    if (!docs.length) {
      toast('There are no other pages to look through yet.', 'error');
      return;
    }

    // This document's own folder first, for the same reason as a linked PDF:
    // the page meant is nearly always one filed with these notes.
    const here = file.folder_id;
    const ordered = [...docs].sort((a, b) => {
      const mine = Number(b.folder_id === here) - Number(a.folder_id === here);
      return mine || a.title.localeCompare(b.title);
    });

    const select = dropdown({ class: 'input' }, ordered.map((doc) => el('option', {
      value: doc.id,
      text: doc.folder_id === here ? doc.title : `${doc.title} — ${folderById(doc.folder_id)?.name ?? 'Library'}`,
    })));
    const caption = el('input', { class: 'input', placeholder: 'Optional label' });

    const chosen = await dialog({
      title: 'Portal to another page',
      confirmLabel: 'Insert',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        el('div', { class: 'field' }, el('label', { text: 'Page' }), select),
        el('div', { class: 'field' }, el('label', { text: 'Label' }), caption),
        el('div', { class: 'sub', text: 'The lines are shown here as they are written there. Edit them on their own page.' }),
      ),
      onConfirm: () => ({ fileId: select.value, caption: caption.value.trim() || null }),
    });
    if (!chosen) return;

    remember();
    const at = blocks.findIndex((b) => b.id === focusedId);
    const block = {
      id: crypto.randomUUID(),
      type: 'portal',
      fileId: chosen.fileId,
      blockId: null,
      caption: chosen.caption,
    };
    blocks.splice(at === -1 ? blocks.length : at + 1, 0, block);
    queue();
    await save();
    draw();
  }

  /**
   * Puts a diagram on the page.
   *
   * Either an existing canvas or a new one, because both are things people
   * actually want here: a diagram drawn earlier in the term belongs in the
   * notes that reference it, and a diagram thought of while writing has to be
   * startable without leaving the page. A new one is filed in this document's
   * own folder and named after the document, so the library does not fill up
   * with "Untitled".
   */
  async function insertDiagram() {
    const here = file.folder_id;
    const canvases = state.files.filter((f) => f.kind === 'canvas' && !f.trashed_at);

    // The document's own folder first, for the same reason as linking a PDF.
    const ordered = [...canvases].sort((a, b) => {
      const mine = Number(b.folder_id === here) - Number(a.folder_id === here);
      return mine || a.title.localeCompare(b.title);
    });

    const NEW = '__new__';
    const select = dropdown({ class: 'input' },
      el('option', { value: NEW, text: 'New diagram…' }),
      ordered.map((c) => el('option', {
        value: c.id,
        text: c.folder_id === here ? c.title : `${c.title} — ${folderById(c.folder_id)?.name ?? 'Library'}`,
      })),
    );
    const name = el('input', { class: 'input', placeholder: `${file.title} diagram` });
    const nameField = el('div', { class: 'field' }, el('label', { text: 'Name' }), name);
    // The name only means anything for a canvas that does not exist yet.
    const syncName = () => { nameField.hidden = select.value !== NEW; };
    select.addEventListener('change', syncName);
    syncName();

    const chosen = await dialog({
      title: 'Diagram',
      confirmLabel: 'Insert',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        el('div', { class: 'field' }, el('label', { text: 'Canvas' }), select),
        nameField,
        el('div', { class: 'sub', text: 'A diagram is a canvas shown on this page. Editing it in the canvas updates it here.' }),
      ),
      onConfirm: () => ({ id: select.value, title: name.value.trim() || `${file.title} diagram` }),
    });
    if (!chosen) return;

    let fileId = chosen.id;
    if (fileId === NEW) {
      try {
        const { file: made } = await api.createFile({
          title: chosen.title.slice(0, 200),
          kind: 'canvas',
          folderId: here,
          background: 'dots',
        });
        await loadLibrary();
        fileId = made.id;
      } catch (err) { reportError(err); return; }
    }

    remember();
    const at = blocks.findIndex((b) => b.id === focusedId);
    const block = { id: crypto.randomUUID(), type: 'canvas', fileId, caption: null };
    blocks.splice(at === -1 ? blocks.length : at + 1, 0, block);
    queue();
    await save();
    draw();
  }

  /** Uploads a PDF into this document's folder and references it from here. */
  async function attachPdf(chosen) {
    const form = new FormData();
    form.append('file', chosen, chosen.name);
    if (file.folder_id) form.append('folderId', file.folder_id);

    toast(`Uploading ${chosen.name}…`);
    try {
      const { fileId: pdfId } = await api.uploadPdf(form);
      await loadLibrary();
      remember();
      blocks.push({ id: crypto.randomUUID(), type: 'pdf', fileId: pdfId, page: 1 });
      queue();
      await save();
      draw();
      toast('PDF added to this document.');
    } catch (err) { reportError(err); }
  }

  // Asked once; the ⋯ menu reads the answer whenever it is opened, so an AI
  // that turns out to be there appears in it without a redraw.
  let aiOn = false;
  aiAvailable().then((on) => { aiOn = on; });

  host.classList.add('doc-view');
  mount(host,
    topbar(fileCrumbs(file),
      status,
      el('button', { class: 'chip', type: 'button', title: 'Import a file into this page', onclick: () => importIntoDocument() }, icon('file-arrow-up', { size: 14 }), 'Import'),
      // Everything else a page can do is in one menu: a row of chips is what
      // stopped a document fitting in half a window.
      pageMenu(() => [
        { icon: 'cards', label: 'Test this page', onSelect: () => toggleQuiz() },
        aiOn ? {
          icon: 'question', label: 'Quiz me with AI',
          onSelect: () => quizDialog({ source: { from: 'document', fileId: file.id }, label: `“${file.title}”` }),
        } : null,
        aiOn ? {
          icon: 'sparkle', label: 'Cards with AI',
          onSelect: () => generateCards({
            source: { from: 'document', fileId: file.id },
            sourceLabel: `“${file.title}”`,
            sourceFileId: file.id,
          }),
        } : null,
        // It saves as you type; this is for the moment before closing the lid.
        { icon: 'floppy-disk', label: 'Save now', onSelect: () => save() },
        { sep: true },
        ...styleItems(),
        { sep: true },
        ...fileItems(file),
      ], { title: 'Document options' }),
    ),
    el('div', { class: 'doc' },
      el('div', { class: 'doc-scroll' }, tags.node, page, refs, related.node),
      quiz,
      dock,
    ),
  );

  draw();
  void drawRefs();

  const onBeforeUnload = () => { if (dirty) save(); };
  window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    clearTimeout(saveTimer);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('mouseup', onPointerUp);
    document.removeEventListener('keydown', onSelectionKey, true);
    document.removeEventListener('copy', onClipboard);
    document.removeEventListener('cut', onClipboard);
    if (dirty) save();
    leaveCopies();
  };
}

function isEmpty(block) {
  if (block.type === 'divider') return false;
  if (block.type === 'flashcard') return !block.front.trim() && !block.back.trim();
  if (block.type === 'table') return false;
  if (block.type === 'image' || block.type === 'pdf') return false;
  if (block.type === 'embed' || block.type === 'portal' || block.type === 'columns') return false;
  return !(block.text ?? '').trim();
}
