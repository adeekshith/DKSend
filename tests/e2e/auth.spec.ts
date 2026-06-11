import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The shared webServer runs without UPLOAD_TOKEN, so this suite spawns its
// own token-protected instance on a separate port.
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'e2e-upload-token';

let server: ChildProcess;

test.beforeAll(async () => {
  const repoRoot = join(__dirname, '../..');
  const bin = process.env.SERVER_BIN || join(repoRoot, 'target/debug/dksend');
  server = spawn(bin, [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      UPLOAD_TOKEN: TOKEN,
      DATA_DIR: mkdtempSync(join(tmpdir(), 'dksend-auth-e2e-')),
      ACCESS_LOG: '0',
    },
    // The server loads static/ relative to its working directory
    cwd: repoRoot,
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch (_) {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('token-protected server did not become ready');
});

test.afterAll(() => {
  server?.kill('SIGTERM');
});

test.describe('upload authentication', () => {
  test('upload page shows the token field and header hint', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#token')).toBeVisible();
    await expect(page.locator('.notes pre')).toContainText('X-Upload-Token');
  });

  test('uploads with the correct token', async ({ page }) => {
    await page.goto(BASE);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'authed.txt');
    writeFileSync(filePath, 'authenticated upload');

    await page.locator('#file').setInputFiles(filePath);
    await page.fill('#token', TOKEN);
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result] h3')).toHaveText('Uploaded');

    // Downloads stay public: fetch the raw URL without any token
    const inputs = page.locator('[data-result] .link-row input');
    const rawUrl = await inputs.nth(1).inputValue();
    const response = await page.request.get(rawUrl);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('authenticated upload');
  });

  test('shows the server message for a wrong token', async ({ page }) => {
    await page.goto(BASE);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const filePath = join(dir, 'denied.txt');
    writeFileSync(filePath, 'should not upload');

    await page.locator('#file').setInputFiles(filePath);
    await page.fill('#token', 'wrong-token');
    await page.click('button[type="submit"]');

    await expect(page.locator('[data-result]')).toContainText('requires an upload token');
    await expect(page.locator('#upload-form')).toBeVisible();
  });
});
