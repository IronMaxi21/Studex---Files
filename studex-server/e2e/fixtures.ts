/**
 * The files the browser tests upload.
 *
 * They are built here rather than committed as binaries because a fixture you
 * cannot read is a fixture nobody maintains: when the PDF test starts failing,
 * the question is always what is in the PDF, and this answers it.
 */

/**
 * A one-page PDF with real, selectable text.
 *
 * The server's own unit tests use a stub that is only structurally valid,
 * which is right for checking a magic-byte sniff and wrong here — this one is
 * opened by pdf.js in a real browser and has to survive that. So it carries a
 * proper cross-reference table with byte offsets, a MediaBox, and a content
 * stream setting Helvetica.
 */
export function samplePdf(lines = ['Studex end-to-end fixture', 'Mitochondria are the powerhouse of the cell.']): Buffer {
  const text = lines
    .map((line, i) => `BT /F1 18 Tf 72 ${700 - i * 28} Td (${line.replace(/([()\\])/g, '\\$1')}) Tj ET`)
    .join('\n');
  const stream = `${text}\n`;

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    `<</Length ${stream.length}>>\nstream\n${stream}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  // Offsets are counted in bytes from the start of the file, which is why the
  // document is assembled as one string and measured as it grows rather than
  // joined at the end.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * A RemNote export, in the Markdown shape the importer reads: indentation is
 * the outline, `::` and `>>` make cards, and `{{...}}` is a cloze.
 */
export const REMNOTE_EXPORT = `# Plant biology
- Mitochondrion :: the organelle that makes ATP
- Chloroplast :: where photosynthesis happens
  - Found in {{plants}} and algae
- Ribosome >> builds proteins from mRNA
`;
