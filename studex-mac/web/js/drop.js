/**
 * Dropping a file onto the window, wherever the pointer happens to be.
 *
 * The import screen has a target you must first go and find; this is the same
 * import with the finding removed. A drag carrying files raises a veil over
 * the whole app — the work behind it blurs away so there is no doubt the drop
 * is going to the app rather than to whatever is under the cursor — and the
 * release is caught on the window, so every pixel is a valid place to let go.
 */
import { el, icon } from './dom.js';
import { log } from './log.js';

/**
 * How long the veil waits after the last dragover before deciding the drag has
 * gone. Counting dragenter against dragleave is the obvious way to do this and
 * it does not survive contact with a real page: a leave fires at every element
 * boundary the pointer crosses, the pairs arrive out of order, and the count
 * drifts until the veil is stuck on screen. A timer cannot drift. The spec has
 * dragover repeating about every 350ms even over a still pointer, so the wait
 * has to clear that comfortably or a paused drag would flicker.
 */
const LINGER_MS = 800;

let veil = null;
let timer = 0;

/**
 * Whether a drag is carrying files.
 *
 * Every engine puts "Files" in `types` for a drag off the desktop, and that
 * alone would do for Finder. It is not the only way a file arrives: some
 * sources describe the drag by its macOS pasteboard type, and an app that
 * hands over a promised file may only show up in `items`. All three count,
 * because the cost of reading one of them too generously is a veil over a
 * drag that turns out not to be a PDF — which is answered — and the cost of
 * reading them too narrowly is a drop that does nothing at all.
 */
const carriesFiles = (event) => {
  const data = event.dataTransfer;
  if (!data) return false;
  const types = data.types ? [...data.types] : [];
  if (types.some((t) => t === 'Files' || t === 'public.file-url' || t === 'NSFilenamesPboardType')) {
    return true;
  }
  return data.items ? [...data.items].some((item) => item.kind === 'file') : false;
};

function raise(caption) {
  if (veil) {
    // Only the hint changes as the drag crosses the app — the folder it would
    // land in follows the pointer.
    veil.querySelector('.dropveil-hint').textContent = caption.hint;
    return;
  }
  const hint = el('div', { class: 'dropveil-hint', text: caption.hint });
  veil = el('div', { class: 'dropveil' },
    el('div', { class: 'dropveil-card' },
      el('div', { class: 'dropveil-mark' }, icon('plus', { bold: true })),
      el('div', { class: 'dropveil-title', text: caption.title }),
      hint,
    ),
  );
  document.body.appendChild(veil);
  // Painted a frame later so the blur and the mark have somewhere to grow from;
  // set with the node, the transition would start already finished.
  requestAnimationFrame(() => veil?.classList.add('in'));
}

function lower() {
  clearTimeout(timer);
  timer = 0;
  veil?.remove();
  veil = null;
}

/**
 * @param {object} handlers
 * @param {() => boolean} handlers.enabled  Whether a drop can be accepted at all.
 * @param {() => { title: string, hint: string }} handlers.caption  What the veil says.
 * @param {(files: File[]) => void} handlers.onDrop
 */
export function installFileDrop({ enabled, caption, onDrop }) {
  window.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;

    // Both dragover and drop have to be claimed, or WebKit reads the file as a
    // navigation. The shell refuses file:// URLs so the app would not actually
    // be replaced, but the drag would end in nothing happening at all.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = enabled() ? 'copy' : 'none';

    // A screen with its own target keeps it: the import zone accepts kinds this
    // does not, and two things claiming one drop is one too many.
    const over = event.target instanceof Element ? event.target.closest('.dropzone') : null;
    if (!enabled() || over) { lower(); return; }

    raise(caption());
    clearTimeout(timer);
    timer = setTimeout(lower, LINGER_MS);
  });

  window.addEventListener('dragleave', (event) => {
    // Every element boundary fires one of these, so the only leave that means
    // the drag is gone is one at the edge of the window itself.
    if (!veil) return;
    const { clientX: x, clientY: y } = event;
    if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) lower();
  });

  window.addEventListener('dragend', lower);

  window.addEventListener('drop', (event) => {
    // Files in hand settle it, whatever the drag called itself on the way in.
    // This is a backstop rather than a second chance: a drop only fires at all
    // because the dragover above was claimed.
    const carried = [...(event.dataTransfer?.files ?? [])];
    if (!carried.length && !carriesFiles(event)) return;
    // A target that already took it got there first — this listener is on the
    // window, so it hears every drop the page handled as well as the ones it
    // did not.
    const taken = event.defaultPrevented;
    event.preventDefault();
    lower();
    if (taken || !enabled()) return;

    // The handler is async and nobody is awaiting it, so a rejection inside it
    // would be an unhandled one — a silent failure in the browser and a
    // console the shell never shows anyone.
    if (carried.length) Promise.resolve(onDrop(carried)).catch((err) => log.error('drop failed', err));
  });
}
