import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { test, expect } from '@playwright/test';
import { samplePdf } from './fixtures.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const PDF_PATH = path.join(here, 'tmp', 'lecture.pdf');

/**
 * Adding a PDF and marking it up.
 *
 * This is the one journey that leans on a real renderer: the page has to come
 * back from pdf.js with a size before anything can be drawn on it, and the
 * mark has to be stored in the page's own coordinates so it survives a reload
 * at a different zoom. Both are checked here.
 */
test('a PDF can be added, drawn on, and the mark kept', async ({ page }) => {
  fs.mkdirSync(path.dirname(PDF_PATH), { recursive: true });
  fs.writeFileSync(PDF_PATH, samplePdf());

  await page.goto('/#/library');
  await expect(page.locator('.nav-item').filter({ hasText: 'Library' })).toBeVisible();

  // The picker is created and clicked by the app, so the file is handed over
  // through the chooser event rather than by setting an input that does not
  // exist until the moment it is asked for.
  await page.getByRole('button', { name: 'Create', exact: false }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Import a file…').click();
  await (await chooser).setFiles(PDF_PATH);

  await expect(page).toHaveURL(/#\/pdf\/[0-9a-f-]{36}$/);

  // One page, sized by the renderer: until pdf.js has opened the document the
  // holder does not exist at all.
  const firstPage = page.locator('.pdf-page[data-page="1"]');
  await expect(firstPage).toHaveCount(1);
  await expect(page.locator('.pdf-canvas').first()).toBeVisible();
  // The text layer proves it rendered rather than merely parsed.
  await expect(page.locator('.pdf-text').first()).toContainText('powerhouse of the cell');

  await page.getByTitle('Draw').click();

  const box = (await firstPage.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  // Several moves, because a stroke of one point is discarded as a stray
  // click rather than saved.
  for (const step of [0.35, 0.4, 0.45, 0.5]) {
    await page.mouse.move(box.x + box.width * step, box.y + box.height * (0.3 + step / 4));
  }
  await page.mouse.up();

  await expect(firstPage.locator('polyline.ann-ink')).toHaveCount(1);

  // The mark is only real if it came back from the server, so the page is
  // loaded again from nothing.
  await page.reload();
  await expect(page.locator('.pdf-page[data-page="1"] polyline.ann-ink')).toHaveCount(1);
});
