import { test, expect, type Page } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:8765", launchOptions: { channel: "chrome" } });
async function login(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("input[name=username]").fill(process.env.APP_USERNAME || "admin");
  await page.locator("input[name=password]").fill(process.env.APP_PASSWORD || "");
  await page.getByRole("button", { name: "进入音乐空间" }).click();
  await expect(page.locator(".album-card").first()).toBeVisible();
}
test("output selection, permission denial and disconnected device fallback", async ({ page }) => {
  await page.addInitScript(() => {
    const list = [{ kind: "audiooutput", deviceId: "dac-1", label: "Test USB DAC" }];
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => list });
    Object.defineProperty(navigator.mediaDevices, "selectAudioOutput", { value: async () => { throw new DOMException("denied", "NotAllowedError"); } });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: async function(id: string) { Object.defineProperty(this, "sinkId", { configurable: true, value: id }); } });
    (window as any).disconnectTestDevice = () => { list.splice(0); navigator.mediaDevices.dispatchEvent(new Event("devicechange")); };
  });
  await login(page);
  await page.getByTitle("输出设备", { exact: true }).click();
  await page.getByLabel("播放输出设备").selectOption("dac-1");
  await expect(page.getByLabel("播放输出设备")).toHaveValue("dac-1");
  await page.getByRole("button", { name: "授权并选择设备" }).click();
  await expect(page.getByRole("dialog", { name: "输出设备" })).toContainText("未获得设备权限");
  await page.evaluate(() => (window as any).disconnectTestDevice());
  await expect(page.getByLabel("播放输出设备")).toHaveValue("");
  await expect(page.getByRole("dialog", { name: "输出设备" })).toContainText("设备已断开");
});
test("insecure LAN explains limitation without requesting microphone", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  await login(page);
  await page.getByTitle("输出设备", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "输出设备" })).toContainText("localhost:8765");
  await expect(page.getByRole("button", { name: "授权显示更多设备" })).toHaveCount(0);
});
test("native client bridge uses no browser stream and exposes explicit DAC modes", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__SUMMER_NATIVE__ = true;
    let receive: (event: any) => void;
    let trackId = "", position = 0, paused = true;
    const emit = (event: string) => receive({ data: { type: "audio", trackId, event, position, paused, duration: 12, format: "WASAPI 共享 · Test DAC · 44100 Hz / 24 bit" } });
    (window as any).nativeTestEnd = () => { position = 12; paused = true; emit("ended"); };
    (window as any).chrome.webview = {
      addEventListener: (_: string, handler: any) => { receive = handler; },
      postMessage: (message: any) => queueMicrotask(() => {
        let result: any = true;
        if (message.command === "devices") result = [{ id: "dac", name: "Test DAC", kind: "wasapi" }];
        receive({ data: { id: message.id, result } });
        if (message.command === "load") { trackId = message.trackId; position = 0; emit("loadedmetadata"); }
        if (message.command === "play") { paused = false; position = .75; emit("play"); emit("playing"); emit("timeupdate"); }
        if (message.command === "pause") { paused = true; emit("pause"); }
        if (message.command === "seek") { position = message.position; emit("timeupdate"); }
      }),
    };
  });
  await login(page);
  await expect(page.getByLabel("音源质量")).toBeDisabled();
  await page.getByTitle("本机 DAC 输出").click();
  await page.getByLabel("原生输出模式").selectOption("asio");
  await expect(page.getByRole("dialog")).toContainText("未发现可用的 64 位 ASIO 驱动");
  await expect(page.getByRole("button", { name: "应用输出设置" })).toBeDisabled();
  await page.getByLabel("原生输出模式").selectOption("shared");
  await page.getByRole("checkbox", { name: "我已调低硬件音量，允许原生播放" }).check();
  await page.getByRole("button", { name: "应用输出设置" }).click();
  await page.getByRole("button", { name: "关闭输出设备" }).click();
  await page.locator(".track-main").first().click();
  await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.currentTime)).toBe(.75);
  expect(await page.locator("audio").getAttribute("src")).toBeNull();
  const initialTrack = await page.locator("audio").getAttribute("data-track-id");
  await page.evaluate(() => (window as any).nativeTestEnd());
  await expect(page.locator("audio")).not.toHaveAttribute("data-track-id", initialTrack!);
  await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  const afterEnd = await page.locator("audio").getAttribute("data-track-id");
  await page.getByTitle("下一首", { exact: true }).click();
  await expect(page.locator("audio")).not.toHaveAttribute("data-track-id", afterEnd!);
  await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  await page.locator("audio").evaluate((el: HTMLAudioElement) => { el.currentTime = 4; el.pause(); });
  await expect.poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(await page.locator("audio").evaluate((el: HTMLAudioElement) => el.currentTime)).toBe(4);
});
test("selected recommendations append to an existing playlist or create a new one", async ({ page }) => {
  const existing = { id: "test-playlist", name: "测试歌单", description: "", revision: 1, tracks: [], count: 0 };
  const saved: any[] = [];
  await page.route("**/api/playlists", route => route.request().method() === "POST"
    ? (saved.push(route.request().postDataJSON()), route.fulfill({ json: existing }))
    : route.fulfill({ json: [existing] }));
  await page.route("**/api/playlists/test-playlist", route => {
    if (route.request().method() === "PUT") saved.push(route.request().postDataJSON());
    return route.fulfill({ json: existing });
  });
  await login(page);
  const songs = (await (await page.request.get("/api/tracks?limit=3")).json()).items;
  await page.route("**/api/ai/chat", route => route.fulfill({ json: { message: "推荐", tracks: songs, action: "suggest", name: "测试", playlist_id: null } }));
  await page.getByPlaceholder("此刻，你想听什么？").fill("推荐");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.locator(".recommendation").last();
  await card.getByRole("checkbox").first().check();
  await card.getByRole("button", { name: "加入歌单…", exact: true }).click();
  await page.locator(".playlist-choice").filter({ hasText: "测试歌单" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].track_ids).toEqual([songs[0].id]);
  expect(saved[0].expected_revision).toBe(1);
  await card.getByLabel("推荐操作范围").selectOption("all");
  await card.getByRole("button", { name: "加入歌单…", exact: true }).click();
  page.once("dialog", dialog => dialog.accept("新建测试歌单"));
  await page.locator(".small-modal").getByRole("button", { name: "新建歌单" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({ name: "新建测试歌单", track_ids: songs.map((t: any) => t.id) });
});
test("AI browse scope, batch queue actions, playlist picker and Shuffle", async ({ page }) => {
  await login(page);
  const songs = (await (await page.request.get("/api/tracks?limit=3")).json()).items;
  const bodies: any[] = [];
  await page.route("**/api/ai/chat", route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { message: "测试推荐", tracks: songs, action: "suggest", name: "测试", playlist_id: null } });
  });
  const oldPhrases = await page.locator(".shuffle-phrases button").allTextContents();
  await page.getByTitle("刷新灵感短语").click();
  const newPhrases = await page.locator(".shuffle-phrases button").allTextContents();
  expect(newPhrases.every(text => !oldPhrases.includes(text))).toBeTruthy();
  await page.locator(".album-card").first().click();
  await expect(page.locator(".album-banner")).toBeVisible();
  const albumName = await page.locator(".album-banner h2").innerText();
  await page.getByPlaceholder("此刻，你想听什么？").fill("推荐三首");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.locator(".recommendation").last();
  await expect(card).toBeVisible();
  expect(bodies[0].scope).toMatchObject({ kind: "album", album: albumName });
  await card.getByRole("button", { name: "追加队尾", exact: true }).click();
  const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem("summer-queue") || "[]").map((t: any) => t.id));
  await expect.poll(queue).toEqual(songs.map((t: any) => t.id));
  await card.getByRole("checkbox").nth(1).check();
  await card.getByRole("button", { name: "插到当前歌曲后", exact: true }).click();
  await expect.poll(queue).toEqual([songs[0].id, songs[1].id, songs[1].id, songs[2].id]);
  await card.getByRole("button", { name: "加入歌单…", exact: true }).click();
  await expect(page.locator(".small-modal")).toContainText(songs[1].title);
  await expect(page.locator(".small-modal").getByRole("button", { name: "新建歌单" })).toBeVisible();
  await page.locator(".small-modal").getByRole("button", { name: "关闭", exact: true }).click();
  // A normal recommendation must not start playback or overwrite the current queue.
  expect(await page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBeTruthy();
  await page.getByRole("button", { name: "发现音乐", exact: true }).click();
  await expect(page.locator(".shuffle-phrases button").first()).toBeVisible();
  await page.locator(".shuffle-phrases button").first().click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].scope).toEqual({ kind: "library" });
  expect(bodies[1].playlist_id).toBeNull();
  expect(bodies[1].exclude_ids).toContain(songs[0].id);
  await expect.poll(queue).toEqual(songs.map((t: any) => t.id));
  await expect(page.getByRole("status").filter({ hasText: "Shuffle" })).toBeVisible();
  await page.locator("audio").evaluate((el: HTMLAudioElement) => el.pause());
  const beforeRefresh = await page.locator(".shuffle-phrases button").allTextContents();
  await page.getByTitle("刷新灵感短语").click();
  expect(await page.locator(".shuffle-phrases button").allTextContents()).not.toEqual(beforeRefresh);
});
