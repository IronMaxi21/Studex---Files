/**
 * Syntax highlighting, written here rather than pulled in.
 *
 * A code block in a set of notes is nearly always short and nearly always one
 * of a dozen languages a student is actually taught. highlight.js would do
 * this, correctly, in about 120 KB — more than KaTeX, for a job that does not
 * need a real parser. What follows is a tokeniser: comments, strings, numbers,
 * keywords, and the name in front of an open bracket. It gets ordinary code
 * right and it degrades into plain text rather than into wrong colours, which
 * is the trade a highlighter in a notes app should make.
 *
 * The same caret rule that governs typeset maths governs this, for the same
 * reason. A highlighted line is a tree of spans; the editor's whole model is
 * that `node.textContent` is the stored text and a caret offset on screen is a
 * caret offset in the data. Highlighting never contradicts that — every token
 * here is a plain `<span>` carrying its own exact source text, nothing is
 * inserted and nothing is dropped, so `textContent` still spells the code out
 * in full. The editor swaps to unhighlighted text on focus anyway, which keeps
 * a repaint from moving the caret mid-word.
 */

import { el } from './dom.js';

const words = (s) => new Set(s.split(' '));

/* Shared across the C-family and everything shaped like it. A language adds
   its own words to these rather than restating the common ones. */
const CONTROL = 'if else for while do switch case default break continue return try catch finally throw new delete typeof instanceof in of';

/**
 * What each language is made of. `keywords` colours as a keyword, `types` as a
 * type or built-in, `literals` as a constant. Anything absent from all three is
 * an identifier, which is left alone — guessing wrong is worse than plain.
 */
export const LANGUAGES = {
  plain:      { label: 'Plain text', mode: 'none' },

  javascript: {
    label: 'JavaScript', mode: 'c', line: ['//'], block: ['/*', '*/'], template: true,
    keywords: words(`${CONTROL} const let var function class extends super this async await yield import export from as static get set void with debugger`),
    types: words('Array Object String Number Boolean Math JSON Date RegExp Promise Map Set Symbol BigInt console window document globalThis'),
    literals: words('true false null undefined NaN Infinity'),
  },
  typescript: {
    label: 'TypeScript', mode: 'c', line: ['//'], block: ['/*', '*/'], template: true,
    keywords: words(`${CONTROL} const let var function class extends implements super this async await yield import export from as static get set readonly public private protected abstract interface type enum namespace declare satisfies keyof infer`),
    types: words('string number boolean any unknown never void object Array Record Partial Promise Map Set Date JSON Math console'),
    literals: words('true false null undefined NaN Infinity'),
  },
  python: {
    label: 'Python', mode: 'c', line: ['#'], triple: true,
    keywords: words('if elif else for while break continue return def class lambda import from as global nonlocal pass raise try except finally with yield assert del async await in is not and or match case'),
    types: words('int float str bool list dict set tuple bytes object range enumerate zip len print open type isinstance super self map filter sum min max abs round sorted'),
    literals: words('True False None'),
  },
  java: {
    label: 'Java', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} class interface enum extends implements public private protected static final abstract synchronized volatile transient native package import throws this super void record sealed permits`),
    types: words('int long short byte char float double boolean String Integer Long Double Boolean Character Object List ArrayList Map HashMap Set HashSet System Math Arrays Collections'),
    literals: words('true false null'),
  },
  kotlin: {
    label: 'Kotlin', mode: 'c', line: ['//'], block: ['/*', '*/'], template: true,
    keywords: words(`${CONTROL} fun val var class object interface data sealed enum companion init constructor override open abstract private public internal protected suspend when is as import package by lateinit`),
    types: words('Int Long Short Byte Char Float Double Boolean String Any Unit Nothing List MutableList Map MutableMap Set Array'),
    literals: words('true false null this it'),
  },
  swift: {
    label: 'Swift', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} func let var class struct enum protocol extension import guard defer where associatedtype init deinit subscript mutating static final override public private internal fileprivate open lazy weak unowned some any inout throws rethrows repeat`),
    types: words('Int Double Float String Bool Character Array Dictionary Set Optional Any AnyObject Void Self Error Result Data Date URL'),
    literals: words('true false nil self super'),
  },
  c: {
    label: 'C', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} struct union enum typedef sizeof static extern const volatile register auto goto inline restrict`),
    types: words('int long short char float double void unsigned signed size_t FILE bool'),
    literals: words('NULL true false'),
  },
  cpp: {
    label: 'C++', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} class struct union enum typedef sizeof static extern const constexpr volatile mutable namespace using template typename public private protected virtual override final friend operator explicit inline nullptr_t noexcept`),
    types: words('int long short char float double void bool unsigned signed size_t string vector map set pair auto ostream istream'),
    literals: words('true false nullptr NULL this'),
  },
  csharp: {
    label: 'C#', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} class struct interface enum record namespace using public private protected internal static readonly const virtual override abstract sealed partial async await get set var event delegate params ref out is as lock checked unchecked`),
    types: words('int long short byte char float double decimal bool string object void List Dictionary Array Task String Math Console'),
    literals: words('true false null this base'),
  },
  go: {
    label: 'Go', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words('if else for range break continue return switch case default func type struct interface map chan go defer select package import const var fallthrough goto'),
    types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any make new len cap append copy delete panic recover'),
    literals: words('true false nil iota'),
  },
  rust: {
    label: 'Rust', mode: 'c', line: ['//'], block: ['/*', '*/'],
    keywords: words('if else for while loop break continue return match fn let mut const static struct enum trait impl type use mod pub crate self super where as dyn ref move unsafe async await macro_rules'),
    types: words('i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap'),
    literals: words('true false None Some Ok Err'),
  },
  ruby: {
    label: 'Ruby', mode: 'c', line: ['#'],
    keywords: words('if elsif else unless for while until begin rescue ensure end def class module do return yield case when then next break retry require require_relative attr_accessor attr_reader attr_writer include extend private public protected lambda proc self'),
    types: words('String Integer Float Array Hash Symbol Range Struct Time puts print p new'),
    literals: words('true false nil'),
  },
  php: {
    label: 'PHP', mode: 'c', line: ['//', '#'], block: ['/*', '*/'],
    keywords: words(`${CONTROL} function class interface trait extends implements public private protected static final abstract namespace use echo print require require_once include include_once global isset unset empty elseif endif foreach endforeach as match fn`),
    types: words('int float string bool array object callable iterable void mixed null self parent'),
    literals: words('true false null TRUE FALSE NULL'),
  },
  r: {
    label: 'R', mode: 'c', line: ['#'],
    keywords: words('if else for while repeat break next function return in library require source'),
    types: words('c vector list matrix data.frame factor numeric character logical integer length nrow ncol sum mean median sd var print paste plot apply sapply lapply'),
    literals: words('TRUE FALSE NULL NA NaN Inf T F'),
  },
  matlab: {
    label: 'MATLAB', mode: 'c', line: ['%'],
    keywords: words('if elseif else end for while break continue switch case otherwise function return try catch global persistent'),
    types: words('zeros ones eye rand size length numel sum mean max min abs sqrt disp fprintf plot figure linspace reshape'),
    literals: words('true false pi Inf NaN'),
  },
  sql: {
    label: 'SQL', mode: 'c', line: ['--'], block: ['/*', '*/'], caseless: true,
    keywords: words('select from where group by having order limit offset insert into values update set delete create table view index alter drop add column primary key foreign references unique not null default constraint join inner left right outer full on as union all distinct case when then else end exists in between like and or asc desc with returning'),
    types: words('int integer bigint smallint text varchar char boolean real float double decimal numeric date time timestamp blob json serial count sum avg min max coalesce cast'),
    literals: words('true false null'),
  },
  bash: {
    label: 'Shell', mode: 'c', line: ['#'],
    keywords: words('if then elif else fi for while until do done case esac function return break continue in select time local export readonly declare source alias unset trap'),
    types: words('echo cd ls cp mv rm mkdir rmdir cat grep sed awk find chmod chown curl wget git sudo apt brew npm node python pip printf read test exit'),
    literals: words('true false'),
  },
  json:  { label: 'JSON', mode: 'c', literals: words('true false null'), keywords: new Set(), types: new Set() },
  yaml:  { label: 'YAML', mode: 'c', line: ['#'], literals: words('true false null yes no on off'), keywords: new Set(), types: new Set() },
  html:  { label: 'HTML', mode: 'markup' },
  xml:   { label: 'XML', mode: 'markup' },
  css:   { label: 'CSS', mode: 'css' },
};

/** The order the picker offers them in: most likely first, then alphabetical. */
export const LANGUAGE_ORDER = [
  'plain', 'python', 'javascript', 'typescript', 'java', 'html', 'css', 'sql',
  'c', 'cpp', 'csharp', 'go', 'json', 'kotlin', 'matlab', 'php', 'r', 'ruby',
  'rust', 'bash', 'swift', 'xml',
];

export const languageLabel = (id) => LANGUAGES[id]?.label ?? LANGUAGES.plain.label;

/** The other names each language goes by, mostly the ones used on a fence. */
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', py3: 'python', python3: 'python',
  'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c',
  cs: 'csharp', 'c#': 'csharp',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  rb: 'ruby', rs: 'rust', kt: 'kotlin', golang: 'go',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  htm: 'html', svg: 'xml', scss: 'css', sass: 'css', less: 'css',
  yml: 'yaml', m: 'matlab', text: 'plain', txt: 'plain', '': 'plain',
};

/** A language name from anywhere — a fence, a paste, a file — as an id here. */
export function resolveLanguage(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (LANGUAGES[key]) return key;
  return ALIASES[key] ?? null;
}

/* ── the tokeniser ─────────────────────────────────────────────────────── */

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /0[xXbBoO][0-9a-fA-F_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+/y;

/** One span of source, kept verbatim. */
const tok = (cls, text) => (cls ? el('span', { class: `tok ${cls}`, text }) : document.createTextNode(text));

/**
 * The C-family scanner, which is nearly every language above: whitespace and
 * punctuation separate things, quotes open strings, and a comment runs either
 * to the end of the line or to its closing pair.
 */
function scanC(src, spec) {
  const out = [];
  const lineStarts = spec.line ?? [];
  const [blockOpen, blockClose] = spec.block ?? [];
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { out.push(tok(null, plain)); plain = ''; } };
  const push = (cls, text) => { flush(); out.push(tok(cls, text)); };

  while (i < src.length) {
    const rest = src.slice(i);

    // A comment to the end of the line.
    const starter = lineStarts.find((s) => rest.startsWith(s));
    if (starter) {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      push('tok-com', src.slice(i, stop));
      i = stop;
      continue;
    }

    // A comment with a closing pair. An unclosed one runs to the end, which is
    // what the compiler would do too.
    if (blockOpen && rest.startsWith(blockOpen)) {
      const end = src.indexOf(blockClose, i + blockOpen.length);
      const stop = end === -1 ? src.length : end + blockClose.length;
      push('tok-com', src.slice(i, stop));
      i = stop;
      continue;
    }

    // Python's triple quotes, which are a string and very often a docstring.
    if (spec.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const fence = rest.slice(0, 3);
      const end = src.indexOf(fence, i + 3);
      const stop = end === -1 ? src.length : end + 3;
      push('tok-str', src.slice(i, stop));
      i = stop;
      continue;
    }

    const quote = src[i];
    if (quote === '"' || quote === "'" || (spec.template && quote === '`')) {
      let j = i + 1;
      // A backslash escapes whatever follows it, including the closing quote.
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      // A single-quoted string that runs past the end of its line is more
      // likely an apostrophe in prose than a string nobody closed.
      const text = src.slice(i, Math.min(j + 1, src.length));
      if (quote !== '`' && text.includes('\n')) { plain += quote; i += 1; continue; }
      push('tok-str', text);
      i += text.length;
      continue;
    }

    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num && num.index === i && /[\d.]/.test(quote)) {
      push('tok-num', num[0]);
      i += num[0].length;
      continue;
    }

    IDENT.lastIndex = i;
    const word = IDENT.exec(src);
    if (word && word.index === i) {
      const text = word[0];
      const key = spec.caseless ? text.toLowerCase() : text;
      let cls = null;
      if (spec.keywords?.has(key)) cls = 'tok-key';
      else if (spec.literals?.has(key)) cls = 'tok-lit';
      else if (spec.types?.has(key)) cls = 'tok-typ';
      // Not a word the language reserves, but something is being called on it.
      else if (src[i + text.length] === '(') cls = 'tok-fun';
      if (cls) push(cls, text);
      else plain += text;
      i += text.length;
      continue;
    }

    plain += src[i];
    i += 1;
  }
  flush();
  return out;
}

/** Tags, attribute names and attribute values; everything else is content. */
function scanMarkup(src) {
  const out = [];
  // A tag, a comment, or a run of text before the next `<`.
  const pattern = /<!--[\s\S]*?(?:-->|$)|<[\s\S]*?(?:>|$)|[^<]+/g;
  for (const [piece] of src.matchAll(pattern)) {
    if (piece.startsWith('<!--')) { out.push(tok('tok-com', piece)); continue; }
    if (!piece.startsWith('<')) { out.push(tok(null, piece)); continue; }
    // Inside a tag: the name, then attribute names and quoted values.
    const inner = /^(<\/?)([A-Za-z][\w:-]*)|("[^"]*"|'[^']*')|([A-Za-z_:][\w:.-]*)(?==)|([\s\S])/g;
    for (const m of piece.matchAll(inner)) {
      if (m[2] !== undefined) { out.push(tok(null, m[1])); out.push(tok('tok-tag', m[2])); }
      else if (m[3] !== undefined) out.push(tok('tok-str', m[3]));
      else if (m[4] !== undefined) out.push(tok('tok-att', m[4]));
      else out.push(tok(null, m[5]));
    }
  }
  return out;
}

/** Selectors, properties and values, which is all CSS really has. */
function scanCss(src) {
  const out = [];
  const pattern = /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n]*"|'[^'\n]*'|(@[\w-]+)|([\w-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b)|(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|pt)?)|([\s\S])/g;
  let plain = '';
  const flush = () => { if (plain) { out.push(tok(null, plain)); plain = ''; } };
  for (const m of src.matchAll(pattern)) {
    const piece = m[0];
    if (piece.startsWith('/*')) { flush(); out.push(tok('tok-com', piece)); }
    else if (piece.startsWith('"') || piece.startsWith("'")) { flush(); out.push(tok('tok-str', piece)); }
    else if (m[1] !== undefined) { flush(); out.push(tok('tok-key', piece)); }
    else if (m[2] !== undefined) { flush(); out.push(tok('tok-att', piece)); }
    else if (m[3] !== undefined || m[4] !== undefined) { flush(); out.push(tok('tok-num', piece)); }
    else plain += piece;
  }
  flush();
  return out;
}

/**
 * The code, as coloured spans. Always returns something drawable: an unknown
 * language, or `plain`, gives one text node back, and the caller can paint it
 * exactly as it paints a highlighted one.
 */
export function highlight(text, language) {
  const src = String(text ?? '');
  const spec = LANGUAGES[language] ?? LANGUAGES.plain;
  if (!src) return [];
  try {
    if (spec.mode === 'markup') return scanMarkup(src);
    if (spec.mode === 'css') return scanCss(src);
    if (spec.mode === 'c') return scanC(src, spec);
  } catch {
    /* A highlighter is decoration. If it throws, the code still has to show. */
  }
  return [document.createTextNode(src)];
}

/**
 * A guess at the language, for a block that arrived without one — pasted in,
 * or written by the tutor into a fenced block with no tag on it. Only confident
 * guesses are returned; `null` means leave it as plain text.
 */
export function guessLanguage(text) {
  const src = String(text ?? '');
  if (!src.trim()) return null;
  const has = (re) => re.test(src);
  if (has(/^\s*<\?php/)) return 'php';
  if (has(/^\s*<(!doctype|html|div|p|span|body|head)\b/i)) return 'html';
  if (has(/^\s*[.#@][\w-]+[^\n]*\{[\s\S]*:[^\n]*;/)) return 'css';
  if (has(/^\s*[[{][\s\S]*["\d[{]/) && !has(/\b(function|def|var|let)\b/)) return 'json';
  if (has(/^\s*(def|class)\s+\w+.*:\s*$/m) || has(/^\s*(import|from)\s+\w+/m) && has(/:\s*$/m)) return 'python';
  if (has(/\b(public|private)\s+(static\s+)?(void|int|String|class)\b/)) return 'java';
  if (has(/#include\s*[<"]/)) return has(/\b(std::|cout|vector<)/) ? 'cpp' : 'c';
  if (has(/\bfunc\s+\w+\s*\(/) && has(/\b(package|import)\s+/)) return 'go';
  if (has(/\bfn\s+\w+\s*\(/) && has(/\blet\s+mut\b|::/)) return 'rust';
  if (has(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b/i)) return 'sql';
  if (has(/\b(const|let|var|function|=>)\b/) && has(/[;{]/)) {
    return has(/:\s*(string|number|boolean)\b|\binterface\s+\w+/) ? 'typescript' : 'javascript';
  }
  if (has(/^#!.*\b(bash|sh|zsh)\b/)) return 'bash';
  return null;
}
