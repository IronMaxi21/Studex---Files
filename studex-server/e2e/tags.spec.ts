import { test, expect } from '@playwright/test';

/**
 * Tags, both ways they arrive: typed as ##name in a page, and picked from the
 * tag sheet. Either one has to show on the page and gather it on the tag page.
 */
test('a ##tag typed in a document and one added from the sheet both stick', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.url().includes('/api/tags') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto('/#/library');
  await page.locator('.create-btn').first().click();
  await page.locator('.menu button').filter({ hasText: 'Document' }).click();
  const newDoc = page.locator('.backdrop');
  await newDoc.locator('input').fill('Tagged page');
  await newDoc.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/#\/doc\/[0-9a-f-]{36}$/);

  await page.locator('.doc-page .btext').first().click();
  await page.keyboard.type('Light reactions ##photosynthesis here');
  await expect(page.locator('.tag-strip .tag-chip')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.tag-strip .tag-chip')).toContainText('photosynthesis');

  await page.locator('.tag-strip .tag-add').click();
  const sheet = page.locator('.backdrop');
  await sheet.locator('input').fill('biology');
  await sheet.locator('input').press('Enter');
  await expect(sheet.locator('.tag-pick.on')).toHaveCount(2);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.tag-strip .tag-chip')).toHaveCount(2);

  await page.locator('.tag-strip .tag-chip-name').filter({ hasText: 'biology' }).click();
  await expect(page).toHaveURL(/#\/tag\/biology$/);
  await expect(page.locator('.tag-row')).toContainText('Tagged page');
  expect(errors).toEqual([]);
});

/**
 * Links that do not decode. A tag with a literal "%" used to be decoded a
 * second time by the tag page and threw; a malformed escape in the hash threw
 * inside the router itself, on every navigation after it, leaving the window
 * unable to go anywhere.
 */
test('a malformed or percent-bearing link does not break navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/#/tag/100%25');
  await expect(page.locator('.tag-page')).toBeVisible();
  await expect(page.locator('.topbar')).toContainText('100%');

  await page.goto('/#/tag/%E0%A4%A');
  await expect(page.locator('.tag-page')).toBeVisible();

  await page.locator('.nav-item').filter({ hasText: 'Library' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  expect(errors).toEqual([]);
});
