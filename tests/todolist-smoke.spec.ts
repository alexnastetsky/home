import { test, expect } from '@playwright/test';

// The todolist SPA is served by a server extension that must win over the
// world cup catch-all. These tests guard both apps' mounting after upgrades.

test('todolist smoke - SPA loads at /todolist/', async ({ page }) => {
  await page.goto('/todolist/');

  await expect(page.getByRole('link', { name: '✓ Todos' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lists' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
});

test('todolist smoke - deep route serves the todo SPA, not the world cup app', async ({ page }) => {
  // Hard navigation to a client route exercises the SPA fallback handler.
  await page.goto('/todolist/history');

  await expect(page.getByRole('link', { name: '✓ Todos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'World Cup 2026 Pool' })).not.toBeVisible();
});

test('todolist smoke - world cup app still owns the root', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'World Cup 2026 Pool' })).toBeVisible();
});
