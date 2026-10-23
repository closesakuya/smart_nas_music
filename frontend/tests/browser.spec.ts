import { test, expect } from "@playwright/test";

test.use({
  baseURL: "http://127.0.0.1:8765",
  launchOptions: { channel: "chrome" },
});

test.beforeAll(async ({request})=>{
  test.setTimeout(90000);
  await expect.poll(async()=>{
    try{return (await request.get('http://127.0.0.1:8765/api/health')).status();}
    catch{return 0;}
  },{timeout:60000}).toBe(200);
});

test("desktop: login, library, original playback and queue", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page
    .locator("input[name=username]")
    .fill(process.env.APP_USERNAME || "admin");
  await page
    .locator("input[name=password]")
    .fill(process.env.APP_PASSWORD || "");
  await page.getByRole("button", { name: "进入音乐空间" }).click();
  await expect(
    page.getByRole("heading", { name: "为此刻，找到一首歌。" }),
  ).toBeVisible();
  await expect(page.locator(".track-row").first()).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({
    path: "../data/previews/desktop.png",
    fullPage: true,
  });
  await page.locator(".track-main").first().click();
  await page.waitForFunction(
    () => {
      const a = document.querySelector("audio");
      return !!a && !a.paused && a.currentTime > 0.25;
    },
    {},
    { timeout: 30000 },
  );
  expect(await page.locator(".player-options select").inputValue()).toBe(
    "original",
  );
  await page.getByTitle("播放队列", { exact: true }).click();
  await expect(page.locator(".queue-item").first()).toBeVisible();
  await page.getByRole("button", { name: "关闭队列" }).click();
  await page.getByRole("button", { name: "文件夹", exact: true }).click();
  await expect(page.locator(".folder-card").first()).toBeVisible();
  await page.locator(".folder-card").first().click();
  await expect(page.locator(".breadcrumbs")).toContainText("音乐库");
  await page.locator("audio").evaluate((a: HTMLAudioElement) => a.pause());
  expect(errors).toEqual([]);
});

test("mobile: responsive library and AI panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .locator("input[name=username]")
    .fill(process.env.APP_USERNAME || "admin");
  await page
    .locator("input[name=password]")
    .fill(process.env.APP_PASSWORD || "");
  await page.getByRole("button", { name: "进入音乐空间" }).click();
  await expect(page.locator(".hero")).toBeVisible();
  await expect(page.locator(".album-card").first()).toBeVisible({
    timeout: 30000,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "../data/previews/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开菜单" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "文件夹", exact: true })
    .click();
  await expect(page.locator(".folder-card").first()).toBeVisible();
  await page.locator(".ai-toggle").click();
  await expect(page.getByText("你的心情，")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "../data/previews/mobile-ai.png",
    fullPage: true,
  });
});
