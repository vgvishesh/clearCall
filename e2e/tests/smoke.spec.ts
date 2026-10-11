import { expect, test } from "@playwright/test";

test("app shell loads and health endpoint responds", async ({ page, request }) => {
  expect((await request.get("/api/health")).ok()).toBe(true);
  await page.goto("/");
  await expect(page).toHaveTitle("Clearcall");
});
