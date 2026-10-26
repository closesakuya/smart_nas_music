import { test, expect, type Page } from '@playwright/test';
test.use({ baseURL: 'http://127.0.0.1:8765', hasTouch: true, launchOptions: { channel: 'chrome' } });
async function login(page: Page) {
  await page.goto('/');
  await page.locator('input[name=username]').fill(process.env.APP_USERNAME || 'admin');
  await page.locator('input[name=password]').fill(process.env.APP_PASSWORD || '');
  await page.getByRole('button', { name: '进入音乐空间' }).click();
  await expect(page.locator('.track-row').first()).toBeVisible();
}
test('home refresh controls update only their own recommendations', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 }); await login(page);
  const hero = await page.locator('.hero-album').getAttribute('aria-label');
  await page.getByTitle('刷新随机发现', { exact: true }).click();
  await expect(page.getByTitle('刷新随机发现', { exact: true })).toBeEnabled();
  await expect(page.locator('.hero-album')).toHaveAttribute('aria-label', hero!);
  const songs = await page.locator('.track-row').allTextContents();
  await page.getByTitle('刷新此刻推荐', { exact: true }).click();
  await expect(page.getByTitle('刷新此刻推荐', { exact: true })).toBeEnabled();
  expect(await page.locator('.track-row').allTextContents()).toEqual(songs);
  await page.getByLabel('首页推荐类型').selectOption('albums');
  const albums = await page.locator('.random-album strong').allTextContents();
  await page.getByTitle('刷新此刻推荐', { exact: true }).click();
  await expect(page.getByTitle('刷新此刻推荐', { exact: true })).toBeEnabled();
  expect(await page.locator('.random-album strong').allTextContents()).toEqual(albums);
});
test('portrait queue drag preserves current song; optional lyrics highlight and close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const songs = (await (await page.request.get('/api/tracks?limit=3')).json()).items;
  await page.evaluate(songs => localStorage.setItem('summer-queue', JSON.stringify(songs)), songs); await page.reload();
  await page.getByTitle('播放队列', { exact: true }).click();
  const handle = page.locator('.queue-item .reorder-handle').first();
  const from = await handle.boundingBox(), to = await page.locator('.queue-item').nth(2).boundingBox();
  const touch = await page.context().newCDPSession(page);
  const x = from!.x + from!.width / 2, y = from!.y + from!.height / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (to!.x + 90 - x) * step / 12, y: y + (to!.y + to!.height / 2 - y) * step / 12 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('summer-queue') || '[]').map((t: any) => t.id))).toEqual([songs[1].id, songs[2].id, songs[0].id]);
  await expect(page.locator('audio')).toHaveAttribute('data-track-id', songs[0].id);
  expect(await page.locator('audio').evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await page.route('**/api/tracks/*/lyrics', route => route.fulfill({ json: { text: '[00:00.00]First line\n[00:10.00]Second line', source: '同目录 LRC', offset: 0 } }));
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  await expect(page.locator('.queue-panel')).toHaveCount(0);
  await expect(page.locator('.lyrics-scroll .active')).toHaveText('First line');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.hero-album')).not.toHaveAttribute('aria-label', '等待专辑加载');
  await page.screenshot({ path: '../data/previews/portrait-lyrics.png' });
  await page.getByRole('button', { name: '关闭歌词' }).click();
  await expect(page.locator('.lyrics-panel')).toHaveCount(0);
});

test('saved playlist order is persisted after dragging', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1500, height: 1000 }); await login(page);
  const songs = (await (await page.request.get('/api/tracks?limit=3')).json()).items;
  const created = await page.request.post('/api/playlists', { data: { name: 'test-drag-' + Date.now(), track_ids: songs.map((t: any) => t.id) } });
  expect(created.ok()).toBeTruthy(); const playlist = await created.json();
  try {
    await page.reload();
    await page.locator('.playlist-nav button').filter({ hasText: playlist.name }).click();
    const from = await page.locator('.track-row .reorder-handle').first().boundingBox();
    const to = await page.locator('.track-row').nth(2).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
    await page.mouse.move(to!.x + 90, to!.y + to!.height / 2, { steps: 10 }); await page.mouse.up();
    await expect.poll(async () => (await (await page.request.get('/api/playlists/' + playlist.id)).json()).tracks.map((t: any) => t.id)).toEqual([songs[1].id, songs[2].id, songs[0].id]);
  } finally { await page.request.delete('/api/playlists/' + playlist.id); }
});
