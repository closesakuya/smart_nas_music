import { chromium, expect } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  await page.waitForURL('http://127.0.0.1:18765/');
  expect(await page.evaluate(() => !!window.__SUMMER_NATIVE__)).toBe(true);
  if (await page.locator('input[name=username]').count()) {
    await page.locator('input[name=username]').fill('desktop-test');
    await page.locator('input[name=password]').fill('desktop-test-password');
    await page.getByRole('button', { name: '进入音乐空间' }).click();
  }
  await expect(page.locator('.track-row').first()).toBeVisible();
  await expect(page.getByLabel('音源质量')).toBeDisabled();
  await expect(page.getByLabel('音量', { exact: true })).toBeDisabled();
  await page.getByTitle('本机 DAC 输出').click();
  await page.getByRole('checkbox', { name: '我已调低硬件音量，允许原生播放' }).check();
  await page.getByRole('button', { name: '应用输出设置' }).click();
  await expect(page.getByRole('dialog')).toContainText('输出已设置');
  await page.getByRole('button', { name: '关闭输出设备' }).click();
  await page.locator('.track-main').first().click();
  await expect.poll(() => page.locator('audio').evaluate(el => ({ time: el.currentTime, paused: el.paused })), { timeout: 60000 }).toMatchObject({ paused: false });
  await expect.poll(() => page.locator('audio').evaluate(el => el.currentTime), { timeout: 30000 }).toBeGreaterThan(.5);
  // No browser media URL: the playback events and PCM output came from the C# engine.
  expect(await page.locator('audio').getAttribute('src')).toBeNull();
  await page.getByTitle('本机 DAC 输出').click();
  await expect(page.getByRole('dialog')).toContainText('WASAPI 共享');
  await expect(page.getByRole('dialog')).toContainText('44100 Hz');
  await page.getByRole('button', { name: '关闭输出设备' }).click();
  await page.locator('audio').evaluate(el => el.pause());
  await expect.poll(() => page.locator('audio').evaluate(el => el.paused)).toBe(true);
  await page.locator('audio').evaluate(el => { el.currentTime = 4; });
  await expect.poll(() => page.locator('audio').evaluate(el => el.currentTime)).toBeGreaterThanOrEqual(4);
  await page.locator('audio').evaluate(el => el.play());
  await expect.poll(() => page.locator('audio').evaluate(el => el.paused)).toBe(false);
  await page.getByTitle('下一首', { exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(el => el.currentTime), { timeout: 30000 }).toBeGreaterThan(.5);
  await page.locator('audio').evaluate(el => el.pause());
  await page.screenshot({ path: '../data/previews/desktop-client.png' });
  console.log('Native WebView bridge, original PCM/WASAPI shared playback, pause, seek and next-track checks passed (silent fixture).');
} finally { await browser.close(); }
