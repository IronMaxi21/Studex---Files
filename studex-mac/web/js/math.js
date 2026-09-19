/**
 * Equation rendering, on top of a vendored KaTeX.
 *
 * Documents store LaTeX source, never rendered markup, so every equation on
 * screen is produced here. KaTeX is used rather than a hand-rolled renderer
 * because getting spacing, delimiter sizing and script placement right is the
 * whole job of a typesetter, and getting them subtly wrong makes maths harder
 * to read than plain text.
 */

/**
 * The UMD build rather than the ES module: KaTeX only minifies the UMD one,
 * and 272 KB against 600 KB is worth a script tag. It is loaded on demand —
 * most notes have no equations in them and should not pay for this.
 */
const KATEX_JS = '/vendor/katex/katex.min.js';
const KATEX_CSS = '/vendor/katex/katex.min.css';

let loading = null;

export function katexLoaded() {
  return Boolean(window.katex);
}

export function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    // The stylesheet carries the fonts, so it goes in first; the script alone
    // renders equations in whatever face the page happens to be using.
    if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = KATEX_CSS;
      document.head.append(link);
    }
    const script = document.createElement('script');
    script.src = KATEX_JS;
    script.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('katex missing')));
    script.onerror = () => reject(new Error('could not load katex'));
    document.head.append(script);
  }).catch((err) => {
    // A failed load must not poison every later attempt: the next equation
    // drawn gets a fresh try rather than the cached rejection.
    loading = null;
    throw err;
  });

  return loading;
}

/**
 * Draws `latex` into `target`.
 *
 * `throwOnError: false` is deliberate. Half-typed input is the normal state of
 * an equation being written, and KaTeX's own error rendering — the offending
 * source in red, in place — says more about what is wrong than an exception
 * caught here ever could.
 */
export function renderMath(target, latex, { display = true } = {}) {
  const source = String(latex ?? '');
  if (!source.trim()) {
    target.textContent = '';
    target.classList.add('math-empty');
    return;
  }
  target.classList.remove('math-empty');

  const draw = () => {
    try {
      window.katex.render(source, target, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        // Macro definitions can be written to expand forever. This is the
        // guard against a document that will not finish rendering.
        maxExpand: 1000,
        // No \href, \url or \includegraphics: an equation is typography, and
        // nothing in a note should be able to become a link by being maths.
        trust: false,
      });
    } catch {
      // Only a genuine KaTeX fault reaches here, since syntax errors are
      // rendered rather than thrown. Showing the source is the honest
      // fallback — the student's own text, unstyled but not lost.
      target.textContent = source;
    }
  };

  if (window.katex) {
    draw();
    return;
  }

  // Until the library arrives, the source stands in for the equation. It is
  // the right placeholder: it is what the student typed, and if the load fails
  // it is what they keep.
  target.textContent = source;
  loadKatex().then(draw).catch(() => {});
}

/**
 * Does this string carry any maths? Cheap enough to gate the mixed renderer
 * on, so a card with no equation in it pays nothing for the LaTeX support.
 *
 * Both notations count. `$…$` is what the app's own editors write, and
 * `\(…\)` / `\[…\]` is what a language model writes unless it is told
 * otherwise — and since the tutor's answers come through here, being strict
 * about the delimiter would mean showing a student raw backslashes.
 */
export function hasMath(text) {
  return /(?<!\\)\$|\\[([]/.test(String(text ?? ''));
}

/**
 * Splits a line into text and maths runs. `$$…$$` and `\[…\]` are display
 * equations, `$…$` and `\(…\)` are inline; a `\$` is a literal dollar and
 * never a delimiter. Unterminated delimiters are treated as plain text,
 * because a half-typed `$` should read as a dollar sign rather than swallow
 * the rest of the card.
 */
export function mathSegments(text) {
  const src = String(text ?? '');
  const out = [];
  let plain = '';
  let i = 0;
  const flush = () => { if (plain) { out.push({ type: 'text', value: plain }); plain = ''; } };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && src[i + 1] === '$') { plain += '$'; i += 2; continue; }
    // LaTeX's own delimiters, which is what a model emits. Handled before the
    // dollar case so that `\[ x = \$5 \]` stays one equation.
    if (ch === '\\' && (src[i + 1] === '[' || src[i + 1] === '(')) {
      const display = src[i + 1] === '[';
      const close = src.indexOf(display ? '\\]' : '\\)', i + 2);
      if (close !== -1) {
        const latex = src.slice(i + 2, close);
        if (latex.trim()) { flush(); out.push({ type: display ? 'display' : 'inline', value: latex }); }
        else plain += src.slice(i, close + 2);
        i = close + 2;
        continue;
      }
    }
    if (ch === '$') {
      const display = src[i + 1] === '$';
      const open = display ? '$$' : '$';
      const close = src.indexOf(open, i + open.length);
      if (close !== -1) {
        const latex = src.slice(i + open.length, close);
        if (latex.trim()) { flush(); out.push({ type: display ? 'display' : 'inline', value: latex }); }
        else plain += src.slice(i, close + open.length);
        i = close + open.length;
        continue;
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/**
 * Renders a line that mixes prose and LaTeX into `target`, replacing whatever
 * was there. Used by the study loop so a card face can hold an equation on
 * either side without the student learning a second field. Falls back to plain
 * text for a line with no maths in it, which is nearly every card.
 */
export function renderMathText(target, text) {
  const str = String(text ?? '');
  if (!hasMath(str)) { target.textContent = str; return; }
  target.textContent = '';
  for (const seg of mathSegments(str)) {
    if (seg.type === 'text') { target.append(document.createTextNode(seg.value)); continue; }
    const span = document.createElement(seg.type === 'display' ? 'div' : 'span');
    span.className = seg.type === 'display' ? 'math-inline-block' : 'math-inline';
    renderMath(span, seg.value, { display: seg.type === 'display' });
    target.append(span);
  }
}

/**
 * Plain-text rendering of an equation, for the places that cannot hold markup
 * — a card's search preview, a document's outline, the window title.
 */
export function mathToText(latex) {
  return String(latex ?? '')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/[{}$\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A whole line — prose and maths — flattened to speech: what VoiceOver reads
 * and what the hands-free reader speaks, with the LaTeX turned into words
 * rather than backslashes.
 */
export function mathLineToText(text) {
  const str = String(text ?? '');
  if (!hasMath(str)) return str;
  return mathSegments(str)
    .map((seg) => (seg.type === 'text' ? seg.value : ` ${mathToText(seg.value)} `))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
