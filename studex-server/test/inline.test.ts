import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INKS, parseInline, stripInlineMarks } from '../src/lib/inline.js';

/** The text of a run, so a test can talk about words rather than segments. */
function words(text: string): string {
  return parseInline(text).map((s) => s.text).join('');
}

describe('coloured text', () => {
  it('colours the words a name asks for', () => {
    const segments = parseInline('the %%rose|exception%% proves it');
    const coloured = segments.filter((s) => s.color);
    assert.equal(coloured.map((s) => s.text).join(''), 'exception');
    assert.equal(coloured[0]?.ink, 'rose');
  });

  it('offers grey, which a highlighter cannot', () => {
    assert.ok(INKS.includes('grey'));
    assert.equal(parseInline('%%grey|aside%%').find((s) => s.color)?.ink, 'grey');
  });

  it('leaves per-cent signs alone when no colour is named', () => {
    // A student writing about yields should not lose half a sentence to a mark
    // they never asked for.
    assert.equal(words('a 50%% gain, then 50%% more'), 'a 50%% gain, then 50%% more');
    assert.equal(parseInline('a 50%% gain, then 50%% more').some((s) => s.color), false);
  });

  it('refuses a colour it does not know', () => {
    assert.equal(parseInline('%%chartreuse|hm%%').some((s) => s.color), false);
  });

  it('keeps a colour and a highlight apart when one is inside the other', () => {
    const inner = parseInline('==sky|a %%rose|b%% c==').filter((s) => s.color);
    assert.equal(inner.map((s) => s.text).join(''), 'b');
    // The highlight's hue must not leak into the colour, nor the other way.
    assert.equal(inner[0]?.ink, 'rose');
    assert.equal(inner[0]?.hue, 'sky');
    assert.equal(inner[0]?.highlight, true);
  });

  it('is invisible to search, which indexes words and not marks', () => {
    assert.equal(stripInlineMarks('the %%rose|exception%% proves it'), 'the exception proves it');
  });
});
