import fs from 'node:fs';
import path from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { ACCOUNT, STORAGE_STATE } from './account.js';

/**
 * Signs up, once, and keeps the session for everything that follows.
 *
 * This is a test in its own right as much as a fixture: first run on a fresh
 * machine is the only path a new user ever takes, and it is the easiest one to
 * break without noticing, because every other test would be started from a
 * seeded database.
 */
setup('create the first account', async ({ page }) => {
  await page.goto('/');

  // First launch opens on the onboarding screens, before sign-in: Next on
  // each, Get Started on the last, and never again after that.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Get Started' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Get Started' })).toHaveCount(0);

  // The form only offers "Create account" once the server has answered that
  // nobody has registered, so waiting for that button is waiting for the
  // first-run decision to have been made.
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeVisible();
  await expect(page.getByText('Set up your library to get started.')).toBeVisible();

  // The labels sit beside their inputs rather than wrapping them, so the
  // fields are addressed by name — which is also what the form submits.
  await page.locator('input[name="name"]').fill(ACCOUNT.name);
  await page.locator('input[name="email"]').fill(ACCOUNT.email);
  await page.locator('input[name="password"]').fill(ACCOUNT.password);
  await create.click();

  // The sidebar is the proof: it is only drawn once the library has loaded
  // behind a real session.
  await expect(page.locator('.nav-item').filter({ hasText: 'Library' })).toBeVisible();

  // Onboarding was the welcome; nothing else covers the page after sign-up.
  // Every screen's first-visit tip is marked as seen, so the tests that follow
  // start from someone who already knows their way around.
  await expect(page.getByRole('dialog', { name: 'Welcome to Studex' })).toHaveCount(0);
  await page.evaluate(async () => {
    const { user } = await (await fetch('/api/auth/me')).json();
    if (!user?.id) throw new Error('signed up, but /api/auth/me has no user');
    const key = `studex.tour.${user.id}`;
    const seen = JSON.parse(localStorage.getItem(key) ?? '{}');
    for (const head of ['library', 'doc', 'pdf', 'flashcards', 'deck', 'calendar', 'topics', 'canvas', 'trash', 'home', 'review']) seen[`tip:${head}`] = true;
    localStorage.setItem(key, JSON.stringify(seen));
  });

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});
