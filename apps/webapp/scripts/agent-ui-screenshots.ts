// Writes a PNG per storybook gallery state and per stored chat, in dark and light.
// Run with `pnpm run agent-ui:screenshots`; configuration is the SCREENSHOT_* env vars below.
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GALLERY_PAGES, MANIFEST, sectionsOnPage } from "../app/routes/storybook.agent-ui/manifest";

const WEBAPP_ROOT = process.cwd().endsWith(path.join("apps", "webapp"))
  ? process.cwd()
  : path.resolve(process.cwd(), "apps", "webapp");

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3030").replace(/\/$/, "");
const EMAIL = process.env.SCREENSHOT_EMAIL ?? "local@trigger.dev";
const ENV_PATH = process.env.SCREENSHOT_ENV_PATH;
const THEMES = (process.env.SCREENSHOT_THEMES ?? "dark,light")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const OUT_DIR = path.resolve(
  WEBAPP_ROOT,
  process.env.SCREENSHOT_OUT ?? path.join("screenshots", "agent-ui")
);
const SCALE = Number(process.env.SCREENSHOT_SCALE ?? 2);
const HEADED = process.env.SCREENSHOT_HEADED === "1";

const CHAT_GROUP = "chats";

const PANEL_SELECTOR = "#dashboard-agent-panel";

const galleryPath = (slug: string) => `/storybook/${slug}`;

type Capture = {
  theme: string;
  group: string;
  sectionId: string;
  title: string;
  file: string;
  ok: boolean;
  error?: string;
};

const captures: Capture[] = [];

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

// Freeze motion so repeated runs produce the same bytes.
async function freezeMotion(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }
    /* Caret blink shows up as a diff in composer screenshots. */
    * { caret-color: transparent !important; }`,
  });
}

async function applyTheme(page: Page, theme: string) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
  }, theme);
}

async function open(page: Page, pathname: string, theme: string) {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {
    // A page with a live stream never goes idle; the settle below covers it.
  });
  await applyTheme(page, theme);
  await freezeMotion(page);
  await page.waitForTimeout(400);
}

// Local dev redirects straight to the magic link, so submitting the form logs us in.
async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  if (!new URL(page.url()).pathname.startsWith("/login")) {
    log("Already authenticated.");
    return;
  }
  await page.fill('input[type="email"]', EMAIL);
  await page.getByRole("button", { name: /continue with email/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
  log(`Logged in as ${EMAIL}.`);
}

async function capture(
  target: Locator,
  { theme, group, sectionId, title }: Omit<Capture, "file" | "ok" | "error">
) {
  const file = path.join(theme, group, `${sectionId}.png`);
  const absolute = path.join(OUT_DIR, file);
  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await target.screenshot({ path: absolute, animations: "disabled" });
    captures.push({ theme, group, sectionId, title, file, ok: true });
    log(`  ok    ${file}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    captures.push({ theme, group, sectionId, title, file, ok: false, error: message });
    log(`  FAIL  ${file} — ${message}`);
  }
}

async function shootGallery(page: Page, theme: string) {
  for (const galleryPage of GALLERY_PAGES) {
    await shootGalleryPage(page, theme, galleryPage);
  }
}

async function shootGalleryPage(
  page: Page,
  theme: string,
  galleryPage: (typeof GALLERY_PAGES)[number]
) {
  const pagePath = galleryPath(galleryPage.slug);
  log(`\nGallery · ${galleryPage.title} · ${theme}`);
  await open(page, pagePath, theme);

  const pathname = new URL(page.url()).pathname;
  if (pathname !== pagePath) {
    throw new Error(
      `${pagePath} redirected to ${pathname}. The storybook route requires an admin user — ` +
        `check that ${EMAIL} has admin set (the local seed does).`
    );
  }

  for (const section of sectionsOnPage(galleryPage.id)) {
    const target = page.locator(`#${section.sectionId}`);
    if (section.expandText) {
      await target
        .getByText(section.expandText, { exact: true })
        .first()
        .click({ timeout: 5_000 })
        .catch(() => {
          log(`  note  ${section.sectionId}: nothing matched "${section.expandText}" to expand`);
        });
      await page.waitForTimeout(150);
    }
    await capture(target, {
      theme,
      group: section.group,
      sectionId: section.sectionId,
      title: section.title,
    });
  }
}

async function openPanel(page: Page): Promise<Locator> {
  const panel = page.locator(PANEL_SELECTOR);
  if (!(await panel.count())) {
    const launcher = page.getByRole("button", { name: "Open chat" });
    if (!(await launcher.count())) {
      throw new Error(
        "No agent launcher on this page. The panel needs DASHBOARD_AGENT_ENABLED=1 (or " +
          "DASHBOARD_AGENT_ADMIN_PREVIEW=1) and an env-scoped path in SCREENSHOT_ENV_PATH."
      );
    }
    await launcher.click();
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(300);
  }
  return panel;
}

async function showHistory(page: Page, panel: Locator) {
  const rows = panel.locator("ol > li");
  if (await rows.count()) return;
  await panel.getByRole("button", { name: "History" }).click();
  await rows.first().waitFor({ state: "visible", timeout: 15_000 });
}

// Indices, not text: a row's accessible name carries a timestamp and titles can share a prefix.
async function chatRows(panel: Locator): Promise<{ index: number; title: string }[]> {
  const rows = panel.locator("ol > li");
  const count = await rows.count();
  const found: { index: number; title: string }[] = [];
  for (let index = 0; index < count; index++) {
    const title = ((await rows.nth(index).locator("span").first().textContent()) ?? "").trim();
    found.push({ index, title });
  }
  return found;
}

async function shootChats(page: Page, theme: string) {
  if (!ENV_PATH) return;
  log(`\nChats · ${theme}`);
  await open(page, ENV_PATH, theme);

  let panel = await openPanel(page);
  await showHistory(page, panel);
  const rows = await chatRows(panel);

  if (rows.length === 0) {
    throw new Error(
      "No conversations in the panel history. Point SCREENSHOT_ENV_PATH at a " +
        "project whose org has chats, or talk to the agent there first."
    );
  }
  log(`  ${rows.length} conversations`);

  for (const { index, title } of rows) {
    // Re-resolve every time: opening a chat leaves the history view and the panel can remount.
    panel = await openPanel(page);
    await showHistory(page, panel);
    await panel.locator("ol > li").nth(index).locator("button").first().click();
    await page.waitForTimeout(600);
    await freezeMotion(page);
    await capture(panel, {
      theme,
      group: CHAT_GROUP,
      sectionId: slugify(title),
      title,
    });
  }
}

function summarise() {
  const failed = captures.filter((c) => !c.ok);
  const byGroup = new Map<string, { ok: number; failed: number }>();
  for (const c of captures) {
    const key = `${c.theme}/${c.group}`;
    const row = byGroup.get(key) ?? { ok: 0, failed: 0 };
    if (c.ok) row.ok++;
    else row.failed++;
    byGroup.set(key, row);
  }

  log("\nSummary");
  const width = Math.max(...[...byGroup.keys()].map((k) => k.length), 5);
  for (const [key, row] of byGroup) {
    log(`  ${key.padEnd(width)}  ${String(row.ok).padStart(3)} ok  ${row.failed} failed`);
  }
  log(`  ${"total".padEnd(width)}  ${captures.length - failed.length} ok  ${failed.length} failed`);
  log(`\nOutput: ${OUT_DIR}`);

  if (failed.length > 0) {
    log("\nFailures:");
    for (const c of failed) log(`  ${c.file}: ${c.error}`);
  }
  return failed.length;
}

async function main() {
  log(`Base URL: ${BASE_URL}`);
  log(`Themes:   ${THEMES.join(", ")}`);
  log(`Sections: ${MANIFEST.length} gallery states across ${GALLERY_PAGES.length} pages`);
  log(`Env path: ${ENV_PATH ?? "(not set — skipping the chat walk)"}`);

  let browser: Browser | undefined;
  const fatal: string[] = [];
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: SCALE,
      // Pin the zone so relative timestamps are comparable between machines.
      timezoneId: "UTC",
      locale: "en-US",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    await login(page);

    for (const theme of THEMES) {
      for (const phase of [shootGallery, shootChats]) {
        try {
          await phase(page, theme);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fatal.push(`${phase.name} (${theme}): ${message}`);
          log(`\n  SKIPPED ${phase.name} (${theme}) — ${message}`);
        }
      }
    }
  } finally {
    await browser?.close();
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        themes: THEMES,
        envPath: ENV_PATH ?? null,
        deviceScaleFactor: SCALE,
        captures,
        skipped: fatal,
      },
      null,
      2
    )}\n`
  );

  const failedCount = summarise();
  if (fatal.length > 0) {
    log("\nSkipped phases:");
    for (const message of fatal) log(`  ${message}`);
  }
  if (failedCount > 0 || fatal.length > 0 || captures.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
