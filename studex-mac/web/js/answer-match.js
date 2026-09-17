/**
 * Whether a typed answer is the answer. Shared by Test and Learn so a student
 * is held to the same strictness in both.
 *
 * `strictness` is 'exact', 'normal' or 'lenient', as the student set it.
 */
export function matches(given, expected, strictness) {
  if (strictness === 'exact') return String(given ?? '').trim() === String(expected ?? '').trim();
  if (strictness === 'lenient') return lenient(given) === lenient(expected);
  return normalise(given) === normalise(expected);
}

function lenient(text) {
  return normalise(text)
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[\p{P}]+/gu, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Forgiving comparison: case, spacing and surrounding punctuation only. */
export function normalise(text) {
  return (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .trim();
}
