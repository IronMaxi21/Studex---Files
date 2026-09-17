import { test, expect } from '@playwright/test';

/**
 * The AI screen with no key saved: it must say so, offer the field, and keep
 * the AI entry points out of the topics page. Nothing here reaches Google.
 */
test('Settings → AI shows the key field and the models when no key is set', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/#/settings/ai');
  await expect(page.getByRole('heading', { name: 'AI' })).toBeVisible();
  await expect(page.getByLabel('Gemini API key')).toBeVisible();
  await expect(page.locator('.ai-models .role')).toHaveCount(3);
  await expect(page.getByText('Nothing yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Paste a key first.')).toBeVisible();

  expect(errors).toEqual([]);
});

test('Ask AI opens from the top bar on any page and shows the answer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  // The model is not called: status and chat are answered here.
  await page.route('**/api/ai/status', (route) => route.fulfill({
    json: { available: true, usage: { used: 1, limit: 1000, remaining: 999 }, keySet: true, keySource: 'settings', keyHint: '…abcd', keyEditable: true, models: null, roles: {}, weights: {} },
  }));
  let sent: { messages: Array<{ role: string; content: string }>; context: unknown } | null = null;
  await page.route('**/api/ai/chat', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { answer: 'Start with **enzymes**:\n\n- lock and key\n- induced fit', model: 'm', context: null } });
  });

  // Home deliberately has no AI entry point.
  await page.goto('/#/home');
  await expect(page.getByText('FOCUS TIMER', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  for (const where of ['/#/flashcards', '/#/calendar']) {
    await page.goto(where);
    await expect(page.getByRole('button', { name: 'Ask AI' }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: 'Ask AI' }).first().click();
  const panel = page.getByRole('complementary', { name: 'Ask AI' });
  await expect(panel).toBeVisible();
  await panel.getByLabel('Message').fill('What should I revise first?');
  await panel.getByLabel('Message').press('Enter');

  await expect(panel.locator('.ai-msg.assistant strong')).toHaveText('enzymes');
  await expect(panel.locator('.ai-msg.assistant li')).toHaveCount(2);
  expect(sent!.messages).toEqual([{ role: 'user', content: 'What should I revise first?' }]);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});
