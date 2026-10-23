import { test, expect, type Page } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:8765", launchOptions: { channel: "chrome" } });
async function login(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("input[name=username]").fill(process.env.APP_USERNAME || "admin");
  await page.locator("input[name=password]").fill(process.env.APP_PASSWORD || "");
  await page.getByRole("button", { name: "进入音乐空间" }).click();
  await expect(page.locator(".track-row").first()).toBeVisible();
}
test("similarity defaults to playable library tracks; optional web results are metadata only", async ({ page }) => {
  await login(page);
  const songs = (await (await page.request.get("/api/tracks?limit=3")).json()).items;
  // Seed queue without playing loud real audio.
  await page.evaluate(songs => localStorage.setItem("summer-queue", JSON.stringify(songs)), [songs[0]]);
  await page.reload();
  const requests: any[] = [];
  await page.route("**/api/ai/similar", route => {
    const request = route.request().postDataJSON(); requests.push(request);
    return route.fulfill({ json: request.online ? {
      message: "网络推荐，仅信息", source: "web", tracks: [], seed_count: request.seed_ids.length,
      external_tracks: [{ title: "Outside Song", artist: "Outside Artist", album: "Outside Album", reason: "相似风格推断", playable: false, sources: [{ title: "来源", url: "https://example.com/song" }] }],
    } : { message: "本地推荐", source: "library", tracks: [songs[1]], external_tracks: [], seed_count: 1 } });
  });
  await page.getByTitle("根据当前歌曲推荐相似音乐").click();
  let panel = page.getByRole("dialog", { name: "AI 相似音乐" });
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await panel.getByRole("button", { name: "推荐相似音乐", exact: true }).click();
  await expect(panel.locator(".recommendation")).toBeVisible();
  expect(requests[0]).toEqual({ seed_ids: [songs[0].id], online: false });
  await panel.getByRole("button", { name: "追加队尾", exact: true }).click();
  await page.getByRole("button", { name: "关闭相似推荐" }).click();
  await page.getByTitle("播放队列", { exact: true }).click();
  await page.locator(".queue-toolbar").getByRole("button", { name: "相似音乐", exact: true }).click();
  panel = page.getByRole("dialog", { name: "AI 相似音乐" });
  await expect(panel).toContainText("当前播放队列 · 2 首");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "推荐相似音乐", exact: true }).click();
  await expect(panel).toContainText("Outside Song");
  expect(requests[1]).toEqual({ seed_ids: [songs[0].id, songs[1].id], online: true });
  await expect(panel.getByRole("link", { name: "来源" })).toHaveAttribute("href", "https://example.com/song");
  await expect(panel.locator(".recommendation")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "追加队尾" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("summer-queue") || "[]").length)).toBe(2);
});
test("homepage switches to random albums and adds or replaces the full album", async ({ page }) => {
  await login(page);
  await page.getByLabel("首页推荐类型").selectOption("albums");
  const card = page.locator(".random-album").first();
  await expect(card).toBeVisible();
  const name = await card.locator("strong").innerText();
  await card.getByRole("button", { name: "追加队尾" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("summer-queue") || "[]").length)).toBeGreaterThan(0);
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("summer-queue") || "[]"));
  expect(queued.every((song: any) => song.album === name)).toBeTruthy();
  const params = new URLSearchParams({ album: name, album_artist: queued[0].album_artist, limit: "300" });
  const album = await (await page.request.get("/api/tracks?" + params)).json();
  expect(queued.length).toBe(album.total);
  expect(await page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await card.getByRole("button", { name: "替换并播放" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("summer-queue") || "[]").length)).toBe(album.total);
  await expect(page.locator("audio")).toHaveAttribute("src", new RegExp(queued[0].id));
  await page.locator("audio").evaluate((el: HTMLAudioElement) => el.pause());
});
