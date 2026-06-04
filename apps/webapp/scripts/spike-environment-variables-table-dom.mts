/**
 * DOM spike for Environment Variables table virtualization.
 * Requires: local webapp on :3030, db seeded (local@trigger.dev).
 *
 *   pnpm exec tsx scripts/spike-environment-variables-table-dom.mts
 */
import { prisma } from "../app/db.server";
import { authenticator } from "../app/services/auth.server";
import { sessionStorage } from "../app/services/sessionStorage.server";

const BASE_URL = process.env.SPIKE_BASE_URL ?? "http://localhost:3030";

async function createSessionCookie(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(authenticator.sessionKey, { userId });
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(";")[0]!;
}

function formatSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = el.className && typeof el.className === "string"
    ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
    : "";
  return `${tag}${id}${classes}`;
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "local@trigger.dev" } });
  if (!user) throw new Error("Seed DB first (local@trigger.dev)");

  const org = await prisma.organization.findFirst({ where: { title: "References" }, select: { slug: true } });
  const project = await prisma.project.findFirst({
    where: { slug: { contains: "hello-world" } },
    select: { slug: true },
  });
  const env = await prisma.runtimeEnvironment.findFirst({
    where: { project: { slug: project!.slug }, type: "DEVELOPMENT" },
    select: { slug: true },
  });

  const path = `/orgs/${org!.slug}/projects/${project!.slug}/env/${env!.slug}/environment-variables`;
  const url = `${BASE_URL}${path}`;
  const cookie = await createSessionCookie(user.id);

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: cookie.split("=")[0]!,
      value: cookie.split("=")[1]!,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });

  // Plain string evaluate avoids tsx injecting __name into browser context
  const domReport = await page.evaluate(`
    (function() {
      function findVerticalScrollParent(start) {
        var el = start;
        while (el) {
          var s = getComputedStyle(el);
          var oy = s.overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
            return el;
          }
          el = el.parentElement;
        }
        return null;
      }

      var firstBodyRow = document.querySelector("tbody tr");
      var scrollParent = findVerticalScrollParent(firstBodyRow);
      var rows = Array.from(document.querySelectorAll("tbody > tr")).filter(function(tr) {
        return !tr.querySelector("td[colspan]");
      });

      var heights = rows.slice(0, 200).map(function(tr) {
        return tr.getBoundingClientRect().height;
      });
      var min = heights.length ? Math.min.apply(null, heights) : 0;
      var max = heights.length ? Math.max.apply(null, heights) : 0;
      var sum = heights.reduce(function(a, b) { return a + b; }, 0);
      var avg = heights.length ? sum / heights.length : 0;

      var table = document.querySelector("table");
      var tableWrapper = table ? table.parentElement : null;
      var thead = document.querySelector("thead");

      var pageBodyEl = null;
      var divs = document.querySelectorAll("div");
      for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        if (String(d.className).indexOf("overflow-hidden") >= 0 && d.querySelector("table")) {
          pageBodyEl = d;
          break;
        }
      }

      return {
        rowCount: rows.length,
        heightsSampled: heights.length,
        rowHeight: { min: min, max: max, avg: avg },
        scrollParent: scrollParent ? {
          tag: scrollParent.tagName,
          className: String(scrollParent.className).slice(0, 120),
          overflowY: getComputedStyle(scrollParent).overflowY,
          clientHeight: scrollParent.clientHeight,
          scrollHeight: scrollParent.scrollHeight
        } : null,
        documentScrollingElement: {
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight
        },
        window: { innerHeight: window.innerHeight, scrollY: window.scrollY },
        tableWrapper: tableWrapper ? {
          tag: tableWrapper.tagName,
          className: String(tableWrapper.className).slice(0, 120),
          overflowX: getComputedStyle(tableWrapper).overflowX,
          overflowY: getComputedStyle(tableWrapper).overflowY,
          clientHeight: tableWrapper.clientHeight,
          scrollHeight: tableWrapper.scrollHeight
        } : null,
        theadPosition: thead ? getComputedStyle(thead).position : null,
        hasStickyActionTd: !!document.querySelector("tbody tr td[class*='sticky']"),
        pageBody: pageBodyEl ? {
          className: String(pageBodyEl.className).slice(0, 120),
          overflowY: getComputedStyle(pageBodyEl).overflowY,
          clientHeight: pageBodyEl.clientHeight,
          scrollHeight: pageBodyEl.scrollHeight
        } : null
      };
    })()
  `);

  console.log("\n=== 1. Scroll container ===\n");
  console.log(JSON.stringify(domReport.scrollParent, null, 2));
  console.log("\nDocument scrollingElement:", domReport.documentScrollingElement);
  console.log("\nTable wrapper:", domReport.tableWrapper);
  console.log("\nPageBody-like ancestor:", domReport.pageBody);
  console.log("\nScroll candidates (overflow content):", domReport.scrollCandidates);

  console.log("\n=== 2. Row heights (first 200 rows) ===\n");
  console.log(`Total tbody data rows: ${domReport.rowCount}`);
  console.log(
    `min=${domReport.rowHeight.min.toFixed(1)}px max=${domReport.rowHeight.max.toFixed(1)}px avg=${domReport.rowHeight.avg.toFixed(1)}px`
  );

  console.log("\n=== 3. Header / sticky ===\n");
  console.log(`thead position: ${domReport.theadPosition}`);
  console.log(`sticky action td in tbody: ${domReport.hasStickyActionTd}`);

  // Scroll test: can window scroll?
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(300);
  const afterScroll = await page.evaluate(() => ({
    scrollY: window.scrollY,
    docScroll: document.scrollingElement?.scrollTop ?? 0,
  }));
  console.log("\n=== Scroll behavior (PageDown) ===\n");
  console.log(`window.scrollY: ${beforeScroll} -> ${afterScroll.scrollY}`);
  console.log(`document scrollTop: ${afterScroll.docScroll}`);

  await browser.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
