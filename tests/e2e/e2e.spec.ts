import { test, expect } from "@playwright/test";

test("Create an account", async ({ page }) => {
  await page.goto("http://localhost:3030/login");
  await page.getByRole("link", { name: "Continue with Email" }).click();

  await page
    .getByPlaceholder("Email Address")
    .type(`test_${Math.random()}@test.com`);
  await page.getByRole("button", { name: "Send a magic link" }).click();

  await expect(page.getByText("Welcome to Trigger.dev")).toBeVisible();
  await page.getByLabel("Full name").type("John Doe");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Organization name").type("Test Org");
  await page.getByLabel("Project name").type("Test Project");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.locator("h1").filter({ hasText: /^Jobs$/ })).toBeVisible();
});

test("Verify jobs from the test nextjs project", async ({ page }) => {
  await page.goto("http://localhost:3030");
  await page.getByRole("link", { name: "Continue with Email" }).click();

  await page.getByPlaceholder("Email Address").type("test-user@test.com");
  await page.getByRole("button", { name: "Send a magic link" }).click();

  await page.getByRole("link", { name: /Test Project/ }).click();
  await expect(page.locator("h1").filter({ hasText: /^Jobs$/ })).toBeVisible();

  await page.getByRole("link", { name: "Environments & API Keys" }).click();
  await expect(
    page.locator("h1").filter({ hasText: "Environments & API Keys" })
  ).toBeVisible();
  await expect(
    page.locator("h3").filter({ hasText: "nextjs-test" })
    // Set the timeout high to allow the cli to register jobs
  ).toBeVisible({ timeout: 15000 });

  await page.getByRole("link", { name: "Jobs" }).click();
  await expect(page.locator("h1").filter({ hasText: /^Jobs$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Test Job One/ })).toBeVisible();
});
