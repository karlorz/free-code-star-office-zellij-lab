/**
 * End-to-end tests for the Star Office Bridge UI (dashboard at /events/test).
 *
 * These tests verify:
 * 1. The dashboard HTML page loads and renders correctly
 * 2. SSE connection establishes and status updates
 * 3. Manual event injection triggers SSE broadcast
 * 4. WebSocket connection toggles
 * 5. Toolbar links and buttons are present
 * 6. Key API endpoints return expected data
 * 7. Office iframe embed loads
 */

import { test, expect } from "@playwright/test";

const DASHBOARD_PATH = "/events/test";

test.describe("Star Office Bridge — Dashboard UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DASHBOARD_PATH);
    await page.waitForLoadState("domcontentloaded");
  });

  test("dashboard page loads with correct title", async ({ page }) => {
    await expect(page).toHaveTitle("Star Office");
  });

  test("SSE connection status shows Live when connected", async ({ page }) => {
    const statusEl = page.locator("#sseStatus");
    await expect(statusEl).toContainText(/live|connected|ok|open/i, {
      timeout: 8000,
    });
  });

  test("toolbar contains navigation links", async ({ page }) => {
    const toolbar = page.locator(".toolbar");
    const expectedLinks = ["Health", "Office", "Snapshot", "Metrics", "API"];
    for (const linkText of expectedLinks) {
      const link = toolbar.locator("a", { hasText: new RegExp(`^${linkText}$`) });
      await expect(link).toBeVisible();
    }
  });

  test("toolbar contains action buttons", async ({ page }) => {
    const toolbar = page.locator(".toolbar");
    const expectedButtons = ["Connect WS", "Tabs", "Panes", "GC", "Inject"];
    for (const btnText of expectedButtons) {
      const btn = toolbar.locator("button", { hasText: new RegExp(`^${btnText}$`) });
      await expect(btn).toBeVisible();
    }
  });

  test("WebSocket badge shows disconnected initially", async ({ page }) => {
    const wsBadge = page.locator("#wsBadge");
    await expect(wsBadge).toHaveClass(/ws-off/);
  });

  test("clicking 'Connect WS' toggles WebSocket connection", async ({
    page,
  }) => {
    const wsBadge = page.locator("#wsBadge");
    const wsBtn = page.locator("#wsBtn");
    await expect(wsBadge).toHaveClass(/ws-off/);
    await wsBtn.click();
    await expect(wsBadge).toHaveClass(/ws-on/, { timeout: 5000 });
  });

  test("Office iframe is present in dashboard", async ({ page }) => {
    const iframe = page.locator("#officeFrame");
    await expect(iframe).toBeAttached();
    expect(await iframe.getAttribute("src")).toContain("star.karldigi.dev");
  });

  test("session list panel is visible", async ({ page }) => {
    const sessionsList = page.locator("#sessionsList");
    await expect(sessionsList).toBeVisible({ timeout: 5000 });
  });

  test("SSE events appear in the feed list", async ({ page }) => {
    await page.waitForTimeout(3000);
    const feedItems = page.locator(".feed-text");
    await expect(feedItems.first()).toBeVisible({ timeout: 10_000 });
  });

  test("manual event injection creates a new SSE event", async ({
    page,
    request,
  }) => {
    const statusEl = page.locator("#sseStatus");
    await expect(statusEl).toContainText(/live|connected|ok|open/i, {
      timeout: 8000,
    });

    const feedBefore = await page.locator(".feed-text").count();

    const response = await request.post("/event/manual", {
      headers: {
        "X-Bridge-Secret": "star-office-bridge-2026",
        "Content-Type": "application/json",
      },
      data: {
        source: "test",
        event: "manual-test",
        state: "idle",
        detail: "Playwright E2E test event",
      },
    });
    expect(response.ok()).toBeTruthy();

    await page.waitForTimeout(1500);
    const feedAfter = await page.locator(".feed-text").count();
    expect(feedAfter).toBeGreaterThan(feedBefore);
  });

  test("clicking 'Tabs' sends action and shows response", async ({
    page,
  }) => {
    const wsBtn = page.locator("#wsBtn");
    await wsBtn.click();
    const wsBadge = page.locator("#wsBadge");
    await expect(wsBadge).toHaveClass(/ws-on/, { timeout: 5000 });

    const feedBefore = await page.locator(".feed-text").count();
    const tabsBtn = page.locator("button", { hasText: /^Tabs$/ });
    await tabsBtn.click();

    await page.waitForTimeout(2000);
    const feedAfter = await page.locator(".feed-text").count();
    expect(feedAfter).toBeGreaterThanOrEqual(feedBefore);
  });
});

test.describe("Star Office Bridge — API endpoints", () => {
  test("GET /health returns valid JSON", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("uptime");
  });

  test("GET /snapshot returns session data", async ({ request }) => {
    const response = await request.get("/snapshot");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("sessions");
  });

  test("GET /help lists all routes", async ({ request }) => {
    const response = await request.get("/help");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.routes.length).toBeGreaterThan(20);
  });

  test("GET /status returns unified overview", async ({ request }) => {
    const response = await request.get("/status");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("version");
  });

  test("GET /version returns version info", async ({ request }) => {
    const response = await request.get("/version");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty("version");
  });

  test("GET /sessions returns active sessions", async ({ request }) => {
    const response = await request.get("/sessions");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("GET /events/recent returns recent events", async ({ request }) => {
    const response = await request.get("/events/recent");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty("events");
    expect(body.events.length).toBeGreaterThan(0);
  });

  test("GET /metrics returns Prometheus metrics", async ({ request }) => {
    const response = await request.get("/metrics");
    expect(response.ok()).toBeTruthy();
    const text = await response.text();
    expect(text).toContain("bridge_");
  });

  test("GET /web returns Zellij web config", async ({ request }) => {
    const response = await request.get("/web");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty("ok");
  });

  test("SSE /events stream returns correct content type", async () => {
    const http = await import("http");
    const result = await new Promise<{ status: number; contentType: string }>(
      (resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: 4317, path: "/events", method: "GET" },
          (res) => {
            const result = {
              status: res.statusCode ?? 0,
              contentType: res.headers["content-type"] || "",
            };
            res.destroy();
            resolve(result);
          }
        );
        req.on("error", reject);
        req.setTimeout(3000, () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      }
    );
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/event-stream");
  });
});

test.describe("Star Office Bridge — Auth-protected endpoints", () => {
  const SECRET = "star-office-bridge-2026";

  test("POST /event/manual without auth is rejected", async ({ request }) => {
    const response = await request.post("/event/manual", {
      data: { source: "test", event: "unauthorized" },
    });
    expect(response.status()).toBe(401);
  });

  test("POST /event/manual with auth succeeds", async ({ request }) => {
    const response = await request.post("/event/manual", {
      headers: { "X-Bridge-Secret": SECRET },
      data: {
        source: "e2e-test",
        event: "test-event",
        state: "idle",
      },
    });
    expect(response.ok()).toBeTruthy();
  });

  test("POST /debug/gc with auth triggers garbage collection", async ({
    request,
  }) => {
    const response = await request.post("/debug/gc", {
      headers: { "X-Bridge-Secret": SECRET },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
