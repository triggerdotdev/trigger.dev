/**
 * The dashboard agent screenshot pack.
 *
 * Walks two things against a running local webapp and writes a PNG per state:
 *
 *   a) the storybook state gallery (`/storybook/agent-ui`) — one capture per
 *      row of `app/routes/storybook.agent-ui/manifest.ts`, which this script
 *      imports so the two can never disagree about what exists;
 *   b) every demo conversation, opened in the real panel on a real env page, so
 *      the review also sees the components in their actual container.
 *
 * Both phases run in dark and light. The app pins `data-theme="dark"` on
 * `<html>` in `root.tsx` and has no theme switch yet, so light is produced by
 * setting that attribute after load — the whole theme layer is attribute-driven
 * (see `app/tailwind.css`), so this is a real light render, not a filter. It is
 * re-applied after every navigation, since a fresh document comes back dark.
 *
 * Usage
 * -----
 *   # terminal 1, from the repo root, with DASHBOARD_AGENT_DEMO=1 in
 *   # apps/webapp/.env alongside DASHBOARD_AGENT_ENABLED=1
 *   pnpm run dev --filter webapp
 *
 *   # terminal 2, from apps/webapp
 *   SCREENSHOT_ENV_PATH=/orgs/references-9dfd/projects/hello-world-97DT/env/dev/runs \
 *     pnpm run agent-ui:screenshots
 *
 * Environment
 * -----------
 *   BASE_URL             default http://localhost:3030
 *   SCREENSHOT_EMAIL     default local@trigger.dev (must be an admin — the
 *                        storybook route redirects everyone else)
 *   SCREENSHOT_ENV_PATH  an env-scoped dashboard path. Omit to skip phase (b).
 *   SCREENSHOT_THEMES    default "dark,light"
 *   SCREENSHOT_OUT       default apps/webapp/screenshots/agent-ui
 *   SCREENSHOT_SCALE     device pixel ratio, default 2
 *   SCREENSHOT_HEADED    "1" to watch it run
 *
 * Output
 * ------
 *   {out}/{theme}/{group}/{sectionId}.png plus {out}/manifest.json listing
 *   every attempted capture, failures included.
 *
 * A failed capture is logged and the walk continues; the exit code is non-zero
 * if anything failed, so this is usable as a check.
 */
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MANIFEST } from "../app/routes/storybook.agent-ui/manifest";

// The package script runs from apps/webapp; tolerate a run from the repo root
// too, so `tsx apps/webapp/scripts/agent-ui-screenshots.ts` works as well.
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

/** The demo history rows are the only ones titled like this. */
const DEMO_TITLE_PREFIX = "Demo ·";
const DEMO_CHAT_GROUP = "demo-chats";

const GALLERY_PATH = "/storybook/agent-ui";
const PANEL_SELECTOR = "#dashboard-agent-panel";

type Capture = {
  theme: string;
  group: string;
  sectionId: string;
  title: string;
  /** Relative to the output directory, so the manifest travels with the pack. */
  file: string;
  ok: boolean;
  error?: string;
};

const captures: Capture[] = [];

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

/** Filename- and anchor-safe slug for a demo chat title. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

/**
 * Freeze everything that moves. Spinners, the panel's slide-in and the chip
 * pulse would otherwise make every run produce different bytes.
 */
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

/** Load a path, apply the theme, and wait for the page to stop moving. */
async function open(page: Page, pathname: string, theme: string) {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {
    // A page with a live stream never goes idle; the settle below covers it.
  });
  await applyTheme(page, theme);
  await freezeMotion(page);
  await page.waitForTimeout(400);
}

/**
 * Local dev sends no email: `sendMagicLinkEmail` redirects straight to the
 * magic link when NODE_ENV is development, so submitting the form logs us in.
 */
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

// ---------------------------------------------------------------------------
// Phase (a): the gallery
// ---------------------------------------------------------------------------

async function shootGallery(page: Page, theme: string) {
  log(`\nGallery · ${theme}`);
  await open(page, GALLERY_PATH, theme);

  const pathname = new URL(page.url()).pathname;
  if (pathname !== GALLERY_PATH) {
    throw new Error(
      `${GALLERY_PATH} redirected to ${pathname}. The storybook route requires an admin user — ` +
        `check that ${EMAIL} has admin set (the local seed does).`
    );
  }

  for (const section of MANIFEST) {
    const target = page.locator(`#${section.sectionId}`);
    if (section.expandText) {
      // A state that only exists after a click, e.g. a tool row's output tab.
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

// ---------------------------------------------------------------------------
// Phase (b): the demo conversations, in the real panel
// ---------------------------------------------------------------------------

/** Open the panel if it isn't already, and return it. */
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

/** Switch the panel to its history list. */
async function showHistory(page: Page, panel: Locator) {
  const rows = panel.locator("ol > li");
  if (await rows.count()) return; // already listing
  await panel.getByRole("button", { name: "History" }).click();
  await rows.first().waitFor({ state: "visible", timeout: 15_000 });
}

/**
 * The demo rows, as `{ index, title }`. Indices rather than text: the row
 * button's accessible name includes a timestamp, and clicking by index survives
 * titles that share a prefix.
 */
async function demoChatRows(panel: Locator): Promise<{ index: number; title: string }[]> {
  const rows = panel.locator("ol > li");
  const count = await rows.count();
  const found: { index: number; title: string }[] = [];
  for (let index = 0; index < count; index++) {
    const title = ((await rows.nth(index).locator("span").first().textContent()) ?? "").trim();
    if (title.startsWith(DEMO_TITLE_PREFIX)) found.push({ index, title });
  }
  return found;
}

async function shootDemoChats(page: Page, theme: string) {
  if (!ENV_PATH) return;
  log(`\nDemo chats · ${theme}`);
  await open(page, ENV_PATH, theme);

  let panel = await openPanel(page);
  await showHistory(page, panel);
  const rows = await demoChatRows(panel);

  if (rows.length === 0) {
    throw new Error(
      "No demo conversations in the panel history. Set DASHBOARD_AGENT_DEMO=1 in " +
        "apps/webapp/.env and restart the webapp."
    );
  }
  log(`  ${rows.length} demo conversations`);

  for (const { index, title } of rows) {
    // Re-resolve every time: opening a chat leaves the history view, and the
    // panel can remount when the layout resizes.
    panel = await openPanel(page);
    await showHistory(page, panel);
    await panel.locator("ol > li").nth(index).locator("button").first().click();
    await page.waitForTimeout(600);
    await freezeMotion(page);
    await capture(panel, {
      theme,
      group: DEMO_CHAT_GROUP,
      sectionId: slugify(title),
      title,
    });
  }
}

// ---------------------------------------------------------------------------

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
  log(`Sections: ${MANIFEST.length} gallery states`);
  log(`Env path: ${ENV_PATH ?? "(not set — skipping the demo-chat walk)"}`);

  let browser: Browser | undefined;
  const fatal: string[] = [];
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: SCALE,
      // The app renders relative timestamps ("2 hours ago") — pinning the zone
      // keeps captures comparable between machines.
      timezoneId: "UTC",
      locale: "en-US",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    await login(page);

    for (const theme of THEMES) {
      for (const phase of [shootGallery, shootDemoChats]) {
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
