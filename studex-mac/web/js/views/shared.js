/**
 * Screen 21 — a shared link, opened by someone with no account.
 *
 * Everything else in this app runs behind a session. This page runs in front of
 * one: the token in the address bar is the whole of the credential, so there is
 * no sidebar, no library, no search, and nothing here can reach anything the
 * link does not name. What the holder gets is the file, and — if the link was
 * made an edit link — the ability to type into it.
 *
 * The read-only rendering is written out again here rather than borrowed from
 * the document editor. The editor is one long closure over a live file, a
 * folder, a card deck, an undo stack and the store; teaching it to run without
 * any of those would have put a `shared` branch through several hundred lines
 * that are hard enough already. This is the same markup and the same
 * stylesheet, and it stays honest by being small.
 */
import { el, icon, mount, clear } from '../dom.js';
import { api } from '../api.js';
import { toast, reportError } from '../store.js';
import { navigate } from '../router.js';
import { renderInline, renderTypeset } from '../inline.js';
import { renderMath, loadKatex } from '../math.js';
import { highlight, LANGUAGES } from '../syntax.js';
import { canvasPreview } from '../canvas-preview.js';
import { relative, FILE_ICON, FILE_LABEL } from '../format.js';

/** Long enough that typing is not a save per keystroke, short enough that
 *  closing the tab shortly after typing does not lose the sentence. */
const SAVE_DELAY = 900;

export async function sharedView(route, host) {
  const token = route.path[1] ?? '';
  const wanted = route.path[2] ?? null;

  mount(host, el('div', { class: 'loading' }, el('div', { class: 'spinner' }), 'Opening…'));

  let shared;
  try {
    ({ shared } = await api.resolveShare(token));
  } catch (err) {
    mount(host, gone(err));
    return null;
  }

  // A file share has exactly one file in it, so there is no list worth
  // showing — the link is the file. A folder share opens on its contents.
  const single = shared.target_type === 'file' ? shared.files[0]?.id ?? null : null;
  const openId = wanted ?? single;
  const file = openId ? shared.files.find((f) => f.id === openId) ?? null : null;

  if (openId && !file) {
    // The id in the address is not in this link's scope. Saying so, rather
    // than asking the server and getting the same 404 a stranger gets.
    mount(host, notice('That file is not part of this link.', () => navigate(`s/${token}`)));
    return null;
  }

  if (!file) {
    mount(host, folderPage(shared, token));
    return null;
  }
  return await filePage(shared, token, file, host);
}

/* ── framing ──────────────────────────────────────────────────────────── */

function gone(err) {
  if (err?.status === 0) {
    return notice('Cannot reach the Studex server.', () => location.reload(), 'Try again');
  }
  return el('div', { class: 'empty-state share-gone' },
    icon('link-break', { size: 28 }),
    el('div', { class: 'title', text: 'This link is no longer available' }),
    el('div', { class: 'sub', text: 'It may have been revoked, or it may have expired. Whoever sent it can make a new one.' }),
  );
}

function notice(message, onRetry, label = 'Back') {
  return el('div', { class: 'empty-state' },
    icon('warning-circle', { size: 26 }),
    el('div', { text: message }),
    onRetry ? el('button', { class: 'btn', text: label, onclick: onRetry }) : null,
  );
}

/**
 * The bar across the top of every shared page.
 *
 * It says three things and no more: what this is, who it came from, and what
 * the holder may do with it. The permission is stated rather than implied,
 * because "can I change this?" is the first question a shared page raises and
 * the worst one to have to answer by trying.
 */
function shareBar(shared, token, file, right) {
  const canEdit = shared.permission === 'edit';
  return el('header', { class: 'share-bar', dataset: { appRegion: 'drag' } },
    el('div', { class: 'mark' }, icon('graduation-cap', { size: 18 })),
    el('div', { class: 'grow', dataset: { appRegion: 'no-drag' } },
      el('div', { class: 'title', text: file?.title ?? shared.title }),
      el('div', { class: 'sub' },
        el('span', { text: `Shared by ${shared.owner_name}` }),
        file && shared.target_type === 'folder'
          ? el('button', {
              class: 'link-btn',
              text: `in ${shared.title}`,
              onclick: () => navigate(`s/${token}`),
            })
          : null,
      ),
    ),
    el('span', {
      class: 'share-perm' + (canEdit ? ' can-edit' : ''),
      title: canEdit
        ? 'Anyone holding this link can change this, including you.'
        : 'This link opens the file for reading. Nothing you do here is saved.',
    }, icon(canEdit ? 'pencil-simple' : 'eye', { size: 12 }), canEdit ? 'Can edit' : 'Read only'),
    right ?? null,
  );
}

/* ── a shared folder ──────────────────────────────────────────────────── */

function folderPage(shared, token) {
  const list = shared.files.length
    ? el('div', { class: 'share-list' }, ...shared.files.map((f) => el('button', {
        class: 'share-item',
        onclick: () => navigate(`s/${token}/${f.id}`),
      },
      icon(FILE_ICON[f.kind] ?? 'file', { size: 18 }),
      el('div', { class: 'grow' },
        el('div', { class: 'name', text: f.title }),
        el('div', { class: 'meta', text: `${FILE_LABEL[f.kind] ?? 'File'} · edited ${relative(f.updated_at)}` }),
      ),
      icon('caret-right', { size: 12 }),
    )))
    : el('div', { class: 'empty-state' },
        icon('folder-open', { size: 26 }),
        el('div', { text: 'There is nothing in this folder yet.' }));

  return el('div', { class: 'share-page' },
    shareBar(shared, token, null, null),
    el('div', { class: 'share-body' },
      list,
      // A folder link shows what sits directly inside it. Saying so is
      // cheaper than letting someone wonder where a subfolder went.
      shared.files.length
        ? el('p', { class: 'share-foot', text: 'This link shows the files directly inside this folder.' })
        : null,
    ),
  );
}

/* ── a shared file ────────────────────────────────────────────────────── */

async function filePage(shared, token, file, host) {
  if (file.kind === 'doc') return await documentPage(shared, token, file, host);
  if (file.kind === 'canvas') return await canvasPage(shared, token, file, host);

  // PDFs and decks are shareable at the permission layer — the link admits
  // them — but neither reader has been taught to run without a session, so
  // the honest thing is to say that rather than show an empty screen.
  mount(host, el('div', { class: 'share-page' },
    shareBar(shared, token, file, null),
    el('div', { class: 'share-body' },
      el('div', { class: 'empty-state' },
        icon(FILE_ICON[file.kind] ?? 'file', { size: 26 }),
        el('div', { class: 'title', text: `${FILE_LABEL[file.kind] ?? 'This file'} cannot be opened from a link yet.` }),
        el('div', { class: 'sub', text: file.kind === 'deck'
          ? 'Save it as a pack and import it in Studex — the cards arrive as a new deck of your own.'
          : 'Documents and canvases can. This one needs Studex itself.' }),
        file.kind === 'deck'
          ? el('a', { class: 'btn primary', href: `/api/shared/${encodeURIComponent(token)}/decks/${file.id}/pack`, download: '' }, icon('package'), 'Save as a pack')
          : null,
      ),
    ),
  ));
  return null;
}

/* ── documents ────────────────────────────────────────────────────────── */

async function documentPage(shared, token, file, host) {
  let loaded;
  try {
    loaded = await api.sharedDocument(token, file.id);
  } catch (err) {
    mount(host, gone(err));
    return null;
  }

  // The permission on the file's own response is the one that governs. The
  // resolve call reports the same thing, but this is the answer from the
  // request that will actually carry the writes.
  const canEdit = loaded.permission === 'edit';
  const doc = loaded.document;
  const blocks = doc.blocks ?? [];
  let revision = doc.revision ?? 0;

  const status = el('span', { class: 'share-status' });
  const page = el('article', { class: 'doc-page share-doc' });

  let timer = null;
  let dirty = false;

  const save = async () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    status.textContent = 'Saving…';
    try {
      const saved = await api.saveSharedDocument(token, file.id, { blocks, expectedRevision: revision });
      revision = saved.document.revision ?? revision + 1;
      status.textContent = 'Saved';
    } catch (err) {
      dirty = true;
      if (err?.status === 409) {
        // Someone else — the owner, or another holder of the same link —
        // saved first. There is no merge here and inventing one silently
        // would be worse than saying so.
        status.textContent = 'Out of date';
        toast('Someone else changed this document. Reload to see their version.', 'error');
        return;
      }
      status.textContent = 'Not saved';
      reportError(err);
    }
  };

  const queue = () => {
    dirty = true;
    status.textContent = 'Editing…';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void save(); }, SAVE_DELAY);
  };

  const draw = () => {
    clear(page);
    if (!blocks.length) {
      page.appendChild(el('div', { class: 'empty-state' },
        icon('file-text', { size: 26 }), el('div', { text: 'This document is empty.' })));
      return;
    }
    blocks.forEach((block, index) => {
      const node = renderShared(block, index, { token, fileId: file.id, canEdit, blocks, queue, draw });
      if (node) page.appendChild(node);
    });
  };

  if (blocks.some((b) => b.type === 'math')) loadKatex().catch(() => {});
  draw();

  mount(host, el('div', { class: 'share-page' },
    shareBar(shared, token, file, canEdit ? status : null),
    el('div', { class: 'share-body doc-body' }, page),
  ));

  // Leaving the page with a pending save would drop whatever was typed in the
  // last second of it, so the timer is flushed rather than merely cancelled.
  const flush = () => { if (timer) { clearTimeout(timer); void save(); } };
  window.addEventListener('beforeunload', flush);
  return () => {
    window.removeEventListener('beforeunload', flush);
    flush();
  };
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
  return `block ${block.type}`;
}

const TEXTUAL = new Set(['paragraph', 'heading', 'bullet', 'numbered', 'todo', 'code']);

function renderShared(block, index, ctx) {
  const { canEdit, blocks, queue } = ctx;

  /** A line of text: a live field on an edit link, inert markup otherwise. */
  const line = (value, placeholder, field = 'text') => {
    const node = el('div', {
      class: 'btext',
      contenteditable: canEdit ? 'plaintext-only' : null,
      spellcheck: canEdit ? 'true' : null,
      'data-placeholder': canEdit ? placeholder : null,
    });
    // Typeset at rest, plain under the caret — the same swap the editor makes,
    // and for the same reason: a caret offset is an offset into the line's own
    // text, which a rendered equation is not.
    let raw = value ?? '';
    node.replaceChildren(...renderTypeset(raw));
    if (!canEdit) return node;
    node.dataset.typeset = '1';
    const paintEdit = () => {
      if (!node.dataset.typeset) return;
      delete node.dataset.typeset;
      node.replaceChildren(...renderInline(raw));
    };
    node.addEventListener('pointerdown', paintEdit);
    node.addEventListener('focus', paintEdit);
    node.addEventListener('input', () => { raw = node.textContent; blocks[index] = { ...blocks[index], [field]: raw }; queue(); });
    node.addEventListener('blur', () => {
      raw = node.textContent;
      node.replaceChildren(...renderTypeset(raw));
      node.dataset.typeset = '1';
    });
    return node;
  };

  /**
   * The same swap as `line`, with syntax colours in place of typeset maths.
   * Highlighted at rest, one flat run of text while the caret is in it, so an
   * offset on screen stays an offset into the stored code.
   */
  const codeLine = () => {
    const node = el('div', {
      class: 'btext code-source',
      contenteditable: canEdit ? 'plaintext-only' : null,
      spellcheck: canEdit ? 'false' : null,
      'data-placeholder': canEdit ? 'Write or paste code' : null,
    });
    let raw = block.text ?? '';
    const lang = block.language && LANGUAGES[block.language] ? block.language : 'plain';
    const paintRest = () => { node.replaceChildren(...highlight(raw, lang)); node.dataset.lit = '1'; };
    paintRest();
    if (!canEdit) return node;
    const paintEdit = () => {
      if (!node.dataset.lit) return;
      delete node.dataset.lit;
      node.textContent = raw;
    };
    node.addEventListener('pointerdown', paintEdit);
    node.addEventListener('focus', paintEdit);
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    });
    node.addEventListener('input', () => { raw = node.textContent; blocks[index] = { ...blocks[index], text: raw }; queue(); });
    node.addEventListener('blur', () => { raw = node.textContent; paintRest(); });
    return node;
  };

  const indent = typeof block.indent === 'number' ? block.indent : 0;
  const wrap = (...children) => el('div', {
    class: blockClass(block),
    dataset: { block: block.id },
    style: indent ? { paddingLeft: `${indent * 22}px` } : null,
  }, ...children);

  switch (block.type) {
    case 'heading':
      return wrap(line(block.text, `Heading ${block.level}`));

    case 'bullet':
      return wrap(el('span', { class: 'twist' }), el('span', { class: 'bullet', text: '•' }), line(block.text, 'List item'));

    case 'numbered': {
      const position = blocks.slice(0, index + 1).filter((b) => b.type === 'numbered').length;
      return wrap(el('span', { class: 'num', text: `${position}.` }), line(block.text, 'List item'));
    }

    case 'todo':
      return wrap(
        el('button', {
          class: 'check' + (block.done ? ' on' : ''),
          text: block.done ? '✓' : '',
          disabled: canEdit ? null : 'disabled',
          onclick: canEdit
            ? () => { blocks[index] = { ...blocks[index], done: !blocks[index].done }; queue(); ctx.draw(); }
            : null,
        }),
        line(block.text, 'To do'),
      );

    case 'divider':
      return wrap(el('div', { class: 'divider-block' }));

    case 'code':
      return wrap(el('div', { class: 'code-block' },
        el('div', { class: 'code-bar' }, el('span', { class: 'code-lang-static', text: LANGUAGES[block.language]?.label ?? 'Plain text' })),
        codeLine(),
      ));

    case 'math':
      return wrap(sharedEquation(block, index, ctx));

    case 'table':
      return wrap(sharedTable(block, index, ctx));

    case 'flashcard': {
      // The deck the card belongs to is the owner's, and a link does not open
      // it, so there is no "Add to deck" here — only the two faces.
      const front = line(block.front, 'Question', 'front');
      front.className = 'front';
      const back = line(block.back, 'Answer', 'back');
      back.className = 'back';
      return wrap(el('div', { class: 'card-block' },
        el('div', { class: 'kicker' }, icon('cards', { size: 14 }), 'FLASHCARD · IN THIS DOC'),
        front,
        back,
      ));
    }

    case 'image':
      return wrap(sharedImage(block, ctx));

    case 'canvas':
      return wrap(sharedDiagram(block, ctx));

    case 'pdf':
      // The reference points into the owner's library, which this link does
      // not open. Naming it is all that can honestly be offered.
      return wrap(el('div', { class: 'attach-block' },
        icon('file-pdf', { size: 18 }),
        el('div', { class: 'grow' },
          el('div', { class: 'name', text: 'A PDF in the owner’s library' }),
          el('div', { class: 'meta', text: `Page ${block.page} — not included in this link` }),
        ),
      ));

    default:
      return TEXTUAL.has(block.type) ? wrap(line(block.text, '')) : null;
  }
}

function sharedEquation(block, index, ctx) {
  const output = el('div', { class: 'math-output' });
  renderMath(output, block.latex ?? '', { display: true });
  const figure = el('figure', { class: 'math-block' }, output);
  if (ctx.canEdit) {
    const source = el('div', {
      class: 'btext math-source',
      contenteditable: 'plaintext-only',
      spellcheck: 'false',
      'data-placeholder': String.raw`\frac{a}{b} = c`,
    });
    source.textContent = block.latex ?? '';
    source.addEventListener('input', () => {
      ctx.blocks[index] = { ...ctx.blocks[index], latex: source.textContent.slice(0, 4000) };
      renderMath(output, source.textContent, { display: true });
      ctx.queue();
    });
    source.addEventListener('focus', () => { loadKatex().catch(() => {}); });
    figure.appendChild(source);
  }
  if (block.caption) figure.appendChild(el('figcaption', { class: 'image-caption', text: block.caption }));
  return figure;
}

/**
 * A table, in the same grid the editor draws.
 *
 * It is the editor's markup because it is the editor's stylesheet: a table
 * rebuilt out of <table> and <td> here would look like a different app halfway
 * down the same page. What is missing is only the tools — adding a row through
 * a link would mean sending a whole restructured block back, and a shared
 * reader has no undo.
 */
function sharedTable(block, index, ctx) {
  const columns = block.columns ?? [];
  const rows = block.rows ?? [];
  const named = Array.isArray(block.rowLabels);
  const cols = (named ? 'minmax(90px, 0.6fr) ' : '') + `repeat(${columns.length}, minmax(0, 1fr))`;
  const grid = el('div', { class: 'table-block' });

  const cell = (value, opts = {}) => {
    const node = el('div', {
      class: 'tcell' + (opts.head ? ' head' : ''),
      contenteditable: ctx.canEdit ? 'plaintext-only' : null,
      'data-placeholder': ctx.canEdit ? opts.placeholder ?? '' : null,
    });
    node.textContent = value ?? '';
    if (ctx.canEdit && opts.onEdit) node.addEventListener('input', () => opts.onEdit(node.textContent));
    return node;
  };

  grid.appendChild(el('div', { class: 'trow head-row', style: { gridTemplateColumns: cols } },
    named ? el('div', { class: 'tcell head corner' }) : null,
    columns.map((col, c) => cell(col, {
      placeholder: 'Column',
      onEdit: (text) => {
        const next = [...ctx.blocks[index].columns];
        next[c] = text;
        ctx.blocks[index] = { ...ctx.blocks[index], columns: next };
        ctx.queue();
      },
    })),
  ));

  rows.forEach((row, r) => {
    grid.appendChild(el('div', { class: 'trow', style: { gridTemplateColumns: cols } },
      named
        ? cell(block.rowLabels[r] ?? '', {
            head: true,
            placeholder: 'Row',
            onEdit: (text) => {
              const labels = [...(ctx.blocks[index].rowLabels ?? [])];
              while (labels.length < rows.length) labels.push('');
              labels[r] = text;
              ctx.blocks[index] = { ...ctx.blocks[index], rowLabels: labels };
              ctx.queue();
            },
          })
        : null,
      columns.map((_, c) => cell(row?.[c] ?? '', {
        onEdit: (text) => {
          const next = ctx.blocks[index].rows.map((existing) => [...existing]);
          while (next[r].length < columns.length) next[r].push('');
          next[r][c] = text;
          ctx.blocks[index] = { ...ctx.blocks[index], rows: next };
          ctx.queue();
        },
      })),
    ));
  });

  return el('div', { class: 'table-group' }, grid);
}

function sharedImage(block, ctx) {
  const figure = el('figure', { class: 'image-block' });
  const img = el('img', {
    src: api.sharedImageUrl(ctx.token, ctx.fileId, block.imageId),
    alt: block.alt ?? '',
    loading: 'lazy',
    draggable: 'false',
  });
  img.addEventListener('error', () => {
    mount(figure, el('div', { class: 'image-missing' },
      icon('image-broken', { size: 18 }), 'This image is no longer here.'));
  });
  figure.appendChild(el('div', { class: 'image-frame' }, img));
  if (block.caption) figure.appendChild(el('figcaption', { class: 'image-caption', text: block.caption }));
  return figure;
}

/**
 * A diagram inside a shared document.
 *
 * The diagram is a canvas file of its own, and the link may or may not admit
 * that file. It is fetched through the same token, and a 404 here means the
 * link covers the document but not the canvas it points at — which is a real
 * and reasonable thing for the owner to have shared, so it is stated plainly
 * instead of being reported as a fault.
 */
function sharedDiagram(block, ctx) {
  const figure = el('figure', { class: 'diagram-block' },
    el('div', { class: 'diagram-head' },
      icon('graph', { size: 16 }),
      el('div', { class: 'name grow', text: 'Diagram' }),
    ),
  );
  const host = el('div', { class: 'diagram-figure' },
    el('div', { class: 'diagram-note', text: 'Loading…' }));
  figure.appendChild(host);
  if (block.caption) figure.appendChild(el('figcaption', { class: 'image-caption', text: block.caption }));

  api.sharedCanvas(ctx.token, block.fileId).then(({ canvas }) => {
    if (!host.isConnected) return;
    const preview = canvasPreview(canvas.objects);
    mount(host, preview ?? el('div', { class: 'diagram-note', text: 'This diagram is empty.' }));
  }).catch(() => {
    if (!host.isConnected) return;
    mount(host, el('div', { class: 'diagram-note', text: 'This diagram is not part of this link.' }));
  });

  return figure;
}

/* ── canvases ─────────────────────────────────────────────────────────── */

/**
 * A shared canvas, drawn rather than edited.
 *
 * The canvas editor is a pointer-driven surface with tools, selection, history
 * and a live viewport; none of it is reachable without a session, and an edit
 * link to a canvas therefore opens read-only in this build. The alternative
 * was to say "Can edit" at the top of a page where nothing can be edited,
 * which is worse than saying this.
 */
async function canvasPage(shared, token, file, host) {
  let loaded;
  try {
    loaded = await api.sharedCanvas(token, file.id);
  } catch (err) {
    mount(host, gone(err));
    return null;
  }

  const preview = canvasPreview(loaded.canvas.objects, { maxHeight: 4000 });
  mount(host, el('div', { class: 'share-page' },
    shareBar(shared, token, file, null),
    el('div', { class: 'share-body' },
      el('div', { class: 'share-canvas' },
        preview ?? el('div', { class: 'empty-state' },
          icon('infinity', { size: 26 }), el('div', { text: 'This canvas is empty.' })),
      ),
      loaded.permission === 'edit'
        ? el('p', { class: 'share-foot', text: 'This link allows editing, but a canvas can only be drawn on inside Studex. It is shown here as it stands.' })
        : null,
    ),
  ));
  return null;
}
