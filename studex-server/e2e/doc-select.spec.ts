import { test, expect } from '@playwright/test';

/**
 * Lines selected as lines.
 *
 * Every line is its own editable field, so the browser alone cannot select
 * across two of them. Dragging from one line into another, or Shift-clicking,
 * has to pick up the lines themselves — and Backspace has to take them away.
 */
test('dragging across lines selects them, and Backspace deletes them', async ({ page }) => {
  await page.goto('/#/library');
  await page.locator('.create-btn').first().click();
  await page.locator('.menu button').filter({ hasText: 'Document' }).click();
  const newDoc = page.locator('.backdrop');
  await newDoc.locator('input').fill('Selecting lines');
  await newDoc.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/#\/doc\/[0-9a-f-]{36}$/);

  await page.locator('.doc-page .btext').first().click();
  for (const line of ['First', 'Second', 'Third', 'Fourth']) {
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  }
  const lines = page.locator('.doc-page > .block .btext');
  await expect(lines.nth(3)).toHaveText('Fourth');

  const from = await lines.nth(0).boundingBox();
  const to = await lines.nth(2).boundingBox();
  await page.mouse.move(from!.x + 4, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.doc-page > .block.selected')).toHaveCount(3);

  await page.keyboard.press('Backspace');
  await expect(page.locator('.doc-page > .block.selected')).toHaveCount(0);
  await expect(lines.first()).toHaveText('Fourth');

  // Shift-click from the caret's line picks up the range too.
  await page.keyboard.press('Meta+z');
  await expect(lines.nth(2)).toHaveText('Third');
  await lines.nth(0).click();
  await lines.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.locator('.doc-page > .block.selected')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.doc-page > .block.selected')).toHaveCount(0);
});
