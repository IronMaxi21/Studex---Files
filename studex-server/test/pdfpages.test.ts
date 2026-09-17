import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { countPdfPages } from '../src/lib/pdfpages.js';

/** A page tree written the ordinary way: plain objects, nothing compressed. */
function plainPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const leaves = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj<</Type/Page/Parent 2 0 R>>endobj\n`,
  ).join('');
  return Buffer.from(
    '%PDF-1.4\n'
      + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
      + `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj\n`
      + leaves
      + 'trailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1',
  );
}

/** The same tree, packed into a FlateDecode object stream as PDF 1.5+ does. */
function compressedPdf(pages: number): Buffer {
  const objects = `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`
    + `2 0 obj<</Type/Pages/Count ${pages}>>endobj\n`;
  const packed = zlib.deflateSync(Buffer.from(objects, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.5\n4 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n', 'latin1'),
    packed,
    Buffer.from('\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
  ]);
}

describe('counting the pages in a PDF', () => {
  it('reads the count off an ordinary page tree', () => {
    assert.equal(countPdfPages(plainPdf(12)), 12);
  });

  it('reads a single-page file', () => {
    assert.equal(countPdfPages(plainPdf(1)), 1);
  });

  it('finds a page tree inside a compressed object stream', () => {
    assert.equal(countPdfPages(compressedPdf(37)), 37);
  });

  it('takes the root of the tree, not an interior node', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n'
        + '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 9>>endobj\n'
        + '3 0 obj<</Type/Pages/Parent 2 0 R/Count 4>>endobj\n'
        + '4 0 obj<</Type/Pages/Parent 2 0 R/Count 5>>endobj\n'
        + '%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), 9);
  });

  it('is not fooled by an outline that also uses /Count', () => {
    // An outline can easily have more entries than the document has pages.
    // Reading /Count from the wrong dictionary is the mistake this guards.
    const pdf = Buffer.from(
      '%PDF-1.4\n'
        + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 3>>endobj\n'
        + '5 0 obj<</Type/Outlines/First 6 0 R/Count 250>>endobj\n'
        + '%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), 3);
  });

  it('does not read /Pages as a /Page leaf', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Pages/Kids[]>>endobj\n%%EOF\n',
      'latin1',
    );
    // No /Count anywhere, and the only /Type is /Pages — so there is nothing
    // to report rather than a phantom single page.
    assert.equal(countPdfPages(pdf), null);
  });

  it('falls back to counting leaves when no node states a count', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n'
        + '3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n'
        + '4 0 obj<</Type/Page/Parent 2 0 R>>endobj\n'
        + '%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), 2);
  });

  it('prefers the later tree after an incremental update', () => {
    const pdf = Buffer.concat([plainPdf(4), Buffer.from(
      '2 0 obj<</Type/Pages/Count 6>>endobj\ntrailer<</Root 1 0 R/Prev 9>>\n%%EOF\n',
      'latin1',
    )]);
    assert.equal(countPdfPages(pdf), 6);
  });

  it('says nothing rather than guessing when the file has no page tree', () => {
    // This is the shape the test suite's own samplePdf has, and the reason
    // uploads of it stay client-declared.
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), null);
  });

  it('survives a stream that will not inflate', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.5\n4 0 obj<</Filter/FlateDecode>>stream\n', 'latin1'),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]),
      Buffer.from('\nendstream endobj\n2 0 obj<</Type/Pages/Count 5>>endobj\n%%EOF\n', 'latin1'),
    ]);
    assert.equal(countPdfPages(pdf), 5);
  });

  it('ignores a count no document could have', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n2 0 obj<</Type/Pages/Count 999999999>>endobj\n%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), null);
  });

  it('reads a tree written with spaces between key and value', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n2 0 obj<< /Type /Pages /Kids [] /Count 8 >>endobj\n%%EOF\n',
      'latin1',
    );
    assert.equal(countPdfPages(pdf), 8);
  });

  it('does not fall over on an empty file', () => {
    assert.equal(countPdfPages(Buffer.alloc(0)), null);
  });
});
