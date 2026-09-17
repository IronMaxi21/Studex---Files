import { test, expect } from '@playwright/test';

/**
 * A link, followed by somebody with no account.
 *
 * This is the one journey the rest of the suite cannot stand in for, because
 * every other test runs with the owner's cookies in the jar. Here the link is
 * made in the app, carried out of it, and opened in a browser context that has
 * never signed in — which is the only way to prove that the token really is
 * the whole of the credential, and that an edit link really writes back to the
 * owner's file.
 */
test('a document can be shared by link and edited by someone with no account', async ({ page, browser }) => {
  await page.goto('/#/library');
  await expect(page.locator('.nav-item').filter({ hasText: 'Library' })).toBeVisible();

  await page.locator('.create-btn').first().click();
  await page.locator('.menu button').filter({ hasText: 'Document' }).click();
  const newDoc = page.locator('.backdrop');
  await expect(newDoc.locator('.title')).toHaveText('New document');
  await newDoc.locator('input').fill('Photosynthesis');
  await newDoc.getByRole('button', { name: 'Create' }).click();

  await expect(page).toHaveURL(/#\/doc\/[0-9a-f-]{36}$/);
  await page.locator('.doc-page .btext').first().click();
  await page.keyboard.type('Light dependent reactions');
  // The editor saves on a debounce, so the text has to have landed before the
  // link is followed — otherwise this would be testing the timer.
  await expect(page.locator('.doc-page')).toContainText('Light dependent reactions');
  await page.waitForTimeout(1200);

  // Share it, as an edit link, from the library's own file menu.
  await page.goto('/#/library');
  const card = page.locator('.file-card, .file-row').filter({ hasText: 'Photosynthesis' }).first();
  await card.click({ button: 'right' });
  await page.locator('.menu button').filter({ hasText: 'Share' }).click();

  const sheet = page.locator('.backdrop');
  await expect(sheet.locator('.title')).toContainText('Photosynthesis');
  // The permission picker is the Studex dropdown, not a native <select>: open
  // it, then choose from its listbox.
  await sheet.locator('.share-new [role="combobox"]').first().click();
  await page.getByRole('listbox').getByRole('option', { name: 'Can edit' }).click();
  await sheet.getByRole('button', { name: 'Create link' }).click();

  // The address is shown exactly once, on the row that was just made.
  const field = sheet.locator('.share-row .copy-line input');
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(url).toMatch(/#\/s\/[A-Za-z0-9_-]{20,}$/);
  await expect(sheet.locator('.share-row .once')).toContainText('cannot show it again');
  await sheet.getByRole('button', { name: 'Done' }).click();

  // A browser that has never signed in to anything.
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guestPage = await guest.newPage();
  await guestPage.goto(url);

  await expect(guestPage.locator('.share-bar .title')).toHaveText('Photosynthesis');
  await expect(guestPage.locator('.share-bar')).toContainText('Shared by Aisha Test');
  await expect(guestPage.locator('.share-perm')).toHaveText('Can edit');
  await expect(guestPage.locator('.share-doc')).toContainText('Light dependent reactions');
  // Nothing of the app proper leaks into a shared page: no sidebar, no tabs.
  await expect(guestPage.locator('.sidebar')).toHaveCount(0);

  const line = guestPage.locator('.share-doc .btext').first();
  await line.click();
  await guestPage.keyboard.press('End');
  await guestPage.keyboard.type(' and the Calvin cycle');
  await expect(guestPage.locator('.share-status')).toHaveText('Saved');

  // The guest wrote into the owner's document, not a copy of it.
  await page.goto('/#/library');
  await page.locator('.file-card, .file-row').filter({ hasText: 'Photosynthesis' }).first().click();
  await expect(page.locator('.doc-page')).toContainText('Light dependent reactions and the Calvin cycle');

  // Revoked, the same address is nothing at all — and says so without hinting
  // whether it ever existed.
  await page.goto('/#/settings/sharing');
  await expect(page.getByRole('heading', { name: 'Sharing' })).toBeVisible();
  await page.locator('.row').filter({ hasText: 'Photosynthesis' }).getByRole('button', { name: 'Revoke' }).click();
  await page.locator('.backdrop').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Link revoked.')).toBeVisible();

  // Same address, so a `goto` would be a same-document no-op and would prove
  // nothing; the link has to be genuinely asked for again.
  await guestPage.reload();
  await expect(guestPage.getByText('This link is no longer available')).toBeVisible();

  await guest.close();
});
