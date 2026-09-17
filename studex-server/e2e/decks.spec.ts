import { test, expect, type Page } from '@playwright/test';

/**
 * Making a deck, filling it, and studying it — the loop the whole app exists
 * for. It is one test rather than three because each step needs what the last
 * one made, and a deck created by an API call would skip the dialogs that are
 * the most breakable part of it.
 */

async function ready(page: Page) {
  await page.goto('/#/flashcards');
  await expect(page.locator('.nav-item').filter({ hasText: 'Library' })).toBeVisible();
}

test('a deck can be made, filled and reviewed', async ({ page }) => {
  await ready(page);

  await page.getByRole('button', { name: 'New deck' }).click();
  const deckDialog = page.locator('.backdrop');
  await expect(deckDialog.locator('.title')).toHaveText('New flashcard deck');
  await deckDialog.locator('input').fill('Cell biology');
  await deckDialog.getByRole('button', { name: 'Create' }).click();

  // Creating a deck opens it, so the route is the receipt that the file exists
  // and that the app knows which one it is.
  await expect(page).toHaveURL(/#\/deck\/[0-9a-f-]{36}$/);
  await expect(page.getByText('This deck is empty. Add your first card', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Add card' }).click();
  const cardDialog = page.locator('.backdrop');
  await expect(cardDialog.locator('.title')).toHaveText('New card');
  await cardDialog.locator('textarea').nth(0).fill('What does the mitochondrion do?');
  await cardDialog.locator('textarea').nth(1).fill('It makes ATP.');
  await cardDialog.getByRole('button', { name: 'Add card' }).click();

  // A brand new card counts as new rather than due, and the study button
  // offers both together.
  await expect(page.locator('.stat').filter({ hasText: 'NEW' }).locator('.value')).toHaveText('1');
  // Addressed by class rather than by name: every button in the app opens with
  // an icon glyph, so accessible names carry a leading space, and the sidebar
  // has a "Study 1 due" of its own.
  await page.locator('.btn.primary').filter({ hasText: 'Study 1' }).click();

  await expect(page.getByText('REVIEW — RECALL THE ANSWER')).toBeVisible();
  await expect(page.locator('.card-surface .q')).toHaveText('What does the mitochondrion do?');
  // The answer is not merely hidden by a class: it is not in the page at all,
  // which is the only version of that promise worth testing.
  await expect(page.locator('.card-surface .a')).toHaveCount(0);

  await page.keyboard.press('Space');
  await expect(page.locator('.card-surface .a')).toHaveText('It makes ATP.');

  // "3" is Good. Rating by keyboard is how anyone gets through a queue.
  await page.keyboard.press('3');
  await expect(page.getByText('1 card reviewed.')).toBeVisible();

  await page.getByRole('button', { name: 'Done' }).click();
  // Nothing is due again today, so the study button is gone rather than
  // offering a queue of nothing.
  await expect(page.locator('.btn.primary').filter({ hasText: /^Study \d+$/ })).toHaveCount(0);
  await expect(page.locator('.stat').filter({ hasText: 'DUE' }).locator('.value')).toHaveText('0');
});
