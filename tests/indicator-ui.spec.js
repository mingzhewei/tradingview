const { test, expect } = require("@playwright/test");

test("indicator registry renders and dynamic panes can be enabled", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) browserErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:5050");
  await page.evaluate(() => {
    localStorage.removeItem("tw-dashboard-chart-count");
    localStorage.removeItem("tw-dashboard-panel-configs");
  });
  await page.reload();

  await page.waitForSelector(".panel");
  await expect(page.locator(".panel")).toHaveCount(4);

  const indicatorCount = await page.evaluate(() => window.TWIndicatorEngine.getIndicators().length);
  expect(indicatorCount).toBeGreaterThanOrEqual(50);

  const firstPanel = page.locator(".panel").first();
  await firstPanel.locator(".indicator-menu summary").click();
  await firstPanel.locator("label", { hasText: "RSI14" }).locator("input").check();
  await firstPanel.locator("label", { hasText: "MACD" }).locator("input").check();
  await expect(firstPanel.locator(".indicator-pane:not(.hidden)")).toHaveCount(2);

  await firstPanel.locator(".indicator-list input").evaluateAll((inputs) => {
    inputs.forEach((input) => {
      if (!input.checked) input.click();
    });
  });
  await expect(firstPanel.locator(".indicator-pane:not(.hidden)")).toHaveCount(5);

  expect(browserErrors).toEqual([]);
});

test("same instrument panels synchronize crosshair across intervals", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) browserErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:5050");
  await page.evaluate(() => {
    localStorage.removeItem("tw-dashboard-chart-count");
    localStorage.removeItem("tw-dashboard-panel-configs");
    localStorage.removeItem("tw-dashboard-replay");
    localStorage.removeItem("tw-dashboard-sync-enabled");
  });
  const firstHistory = page.waitForResponse(
    (response) => response.url().includes("/api/history") && response.url().includes("symbol=BTC") && response.status() === 200,
  );
  await page.reload();
  await firstHistory;

  const panels = page.locator(".panel");
  await expect(panels).toHaveCount(4);
  await expect(page.locator("#syncCharts")).toBeChecked();

  const historyLoaded = page.waitForResponse(
    (response) => response.url().includes("symbol=BTC") && response.url().includes("interval=5m") && response.status() === 200,
  );
  await panels.nth(1).locator(".instrument-select").selectOption("hl:BTC");
  await panels.nth(1).locator(".interval-select").selectOption("5m");
  await historyLoaded;
  await expect(panels.nth(1).locator(".instrument-select")).toHaveValue("hl:BTC");
  await expect(panels.nth(1).locator(".interval-select")).toHaveValue("5m");

  const syncEvent = page.evaluate(
    () =>
      new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(null), 8000);
        window.addEventListener(
          "tw-crosshair-sync",
          (event) => {
            window.clearTimeout(timer);
            resolve(event.detail);
          },
          { once: true },
        );
      }),
  );

  const chartBox = await panels.first().locator(".chart-host").boundingBox();
  await page.mouse.move(chartBox.x + 4, chartBox.y + chartBox.height * 0.45);
  for (const ratio of [0.35, 0.5, 0.66, 0.78]) {
    await page.mouse.move(chartBox.x + chartBox.width * ratio, chartBox.y + chartBox.height * 0.45, { steps: 8 });
  }
  const detail = await syncEvent;

  expect(detail).toMatchObject({
    source: "hyperliquid:BTC",
    target: "hyperliquid:BTC",
  });
  expect(browserErrors).toEqual([]);
});

test("bar replay cutoff and drawing tools work on chart", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) browserErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:5050");
  await page.evaluate(() => {
    localStorage.removeItem("tw-dashboard-chart-count");
    localStorage.removeItem("tw-dashboard-panel-configs");
    localStorage.removeItem("tw-dashboard-replay");
  });
  const firstHistory = page.waitForResponse(
    (response) => response.url().includes("/api/history") && response.url().includes("symbol=BTC") && response.status() === 200,
  );
  await page.reload();
  await firstHistory;
  await page.waitForSelector(".panel");

  const bars = await page.evaluate(async () => {
    const response = await fetch("/api/history?source=hyperliquid&symbol=BTC&interval=1m&limit=80");
    return (await response.json()).bars;
  });
  const cutoff = bars[Math.floor(bars.length / 2)].time;
  const cutoffInputValue = await page.evaluate((epoch) => {
    const date = new Date(epoch * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }, cutoff);

  await page.locator("#replayDate").fill(cutoffInputValue.slice(0, 10));
  await page.locator("#replayTime").fill(cutoffInputValue.slice(11, 16));
  await page.locator("#replayApply").click();
  await expect(page.locator("#replayMode")).toBeChecked();
  await expect(page.locator("#replayStatus")).toContainText("回放");
  const before = await page.locator("#replayStatus").textContent();
  await page.locator("#replayStep").click();
  await expect(page.locator("#replayStatus")).not.toHaveText(before);

  const firstPanel = page.locator(".panel").first();
  const chartBox = await firstPanel.locator(".chart-host").boundingBox();
  await page.locator("#drawingTool").selectOption("trend");
  await page.mouse.click(chartBox.x + chartBox.width * 0.25, chartBox.y + chartBox.height * 0.35);
  await page.mouse.click(chartBox.x + chartBox.width * 0.62, chartBox.y + chartBox.height * 0.54);
  await expect(firstPanel.locator(".drawing-layer line")).toHaveCount(1);

  await page.locator("#drawingTool").selectOption("fib");
  await page.mouse.click(chartBox.x + chartBox.width * 0.28, chartBox.y + chartBox.height * 0.72);
  await page.mouse.click(chartBox.x + chartBox.width * 0.72, chartBox.y + chartBox.height * 0.28);
  await expect(firstPanel.locator(".drawing-label", { hasText: "0.618" })).toBeVisible();

  await page.locator("#drawingClear").click();
  await expect(firstPanel.locator(".drawing-layer line")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

test("bar replay cutoff can be picked directly from chart", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) browserErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:5050");
  await page.evaluate(() => {
    localStorage.removeItem("tw-dashboard-chart-count");
    localStorage.removeItem("tw-dashboard-panel-configs");
    localStorage.removeItem("tw-dashboard-replay");
  });
  const pickHistory = page.waitForResponse(
    (response) => response.url().includes("/api/history") && response.url().includes("symbol=BTC") && response.status() === 200,
  );
  await page.reload();
  await pickHistory;
  await page.waitForSelector(".panel");

  const firstPanel = page.locator(".panel").first();
  const chartBox = await firstPanel.locator(".chart-host").boundingBox();
  await page.locator("#replayPick").click();
  await expect(page.locator("#replayPick")).toHaveText("取消选择");
  await expect(firstPanel.locator(".replay-pick-hint")).toBeVisible();
  await page.mouse.click(chartBox.x + chartBox.width * 0.55, chartBox.y + chartBox.height * 0.48);

  await expect(page.locator("#replayMode")).toBeChecked();
  await expect(page.locator("#replayPick")).toHaveText("图上选择");
  await expect(page.locator("#replayStatus")).toContainText("回放");
  await expect(page.locator("#replayCutoff")).not.toHaveValue("");
  expect(browserErrors).toEqual([]);
});

test("automatic structure indicators can be enabled independently", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) browserErrors.push(message.text());
  });

  await page.goto("http://127.0.0.1:5050");
  await page.evaluate(() => {
    localStorage.removeItem("tw-dashboard-chart-count");
    localStorage.removeItem("tw-dashboard-panel-configs");
  });
  await page.reload();
  await page.waitForSelector(".panel");

  const firstPanel = page.locator(".panel").first();
  await firstPanel.locator(".indicator-menu summary").click();
  await firstPanel.locator("label", { hasText: "自动趋势线" }).locator("input").check();
  await firstPanel.locator("label", { hasText: "自动形态识别" }).locator("input").check();
  await firstPanel.locator("label", { hasText: "支撑压力热力图" }).locator("input").check();

  await expect(firstPanel.locator(".sr-heat-zone").first()).toBeVisible();
  await expect(firstPanel.locator(".auto-trendline-svg line").first()).toBeVisible();
  expect(browserErrors).toEqual([]);
});
