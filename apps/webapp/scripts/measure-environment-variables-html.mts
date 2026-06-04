/**
 * Measures Environment Variables page response breakdown:
 * - total document size
 * - __remixContext / loader script payload
 * - table tbody markup
 *
 * Usage (webapp dev server running on :3030):
 *   pnpm exec tsx scripts/measure-environment-variables-html.mts
 */
import { prisma } from "../app/db.server";
import { EnvironmentVariablesPresenter } from "../app/presenters/v3/EnvironmentVariablesPresenter.server";
import { authenticator } from "../app/services/auth.server";
import { sessionStorage } from "../app/services/sessionStorage.server";

const BASE_URL = process.env.MEASURE_BASE_URL ?? "http://localhost:3030";

async function createSessionCookie(userId: string): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set(authenticator.sessionKey, { userId });
  return sessionStorage.commitSession(session);
}

function extractBetween(html: string, startMarker: string, endMarker: string): string | null {
  const start = html.indexOf(startMarker);
  if (start === -1) return null;
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return null;
  return html.slice(start, end + endMarker.length);
}

function measureRemixContext(html: string): { bytes: number; snippet: string } {
  const markers = [
    'window.__remixContext = ',
    'window.__remixContext=',
    '__remixContext = ',
    '__remixContext=',
  ];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const scriptStart = html.lastIndexOf("<script", idx);
    const scriptEnd = html.indexOf("</script>", idx);
    if (scriptStart === -1 || scriptEnd === -1) continue;
    const script = html.slice(scriptStart, scriptEnd + "</script>".length);
    return { bytes: Buffer.byteLength(script, "utf8"), snippet: marker };
  }
  // Fallback: sum all script tags containing route loader keys
  let total = 0;
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? "";
    if (
      body.includes("environmentVariables") ||
      body.includes("__remixContext") ||
      body.includes("remixRouteModules")
    ) {
      total += Buffer.byteLength(match[0], "utf8");
    }
  }
  return { bytes: total, snippet: "script-tags-fallback" };
}

function measureTableBody(html: string): { bytes: number; trCount: number } {
  const tbodyStart = html.indexOf("<tbody");
  const tbodyEnd = html.indexOf("</tbody>", tbodyStart);
  if (tbodyStart === -1 || tbodyEnd === -1) {
    return { bytes: 0, trCount: 0 };
  }
  const tbody = html.slice(tbodyStart, tbodyEnd + "</tbody>".length);
  const trCount = (tbody.match(/<tr\b/gi) ?? []).length;
  return { bytes: Buffer.byteLength(tbody, "utf8"), trCount };
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes.toLocaleString()} B)`;
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: "local@trigger.dev" } });
  if (!user) {
    throw new Error("Run pnpm run db:seed — local@trigger.dev user not found");
  }

  const org = await prisma.organization.findFirst({
    where: { title: "References" },
    select: { slug: true },
  });
  const project = await prisma.project.findFirst({
    where: { slug: { contains: "hello-world" } },
    select: { slug: true },
  });
  const env = await prisma.runtimeEnvironment.findFirst({
    where: { project: { slug: project!.slug }, type: "DEVELOPMENT" },
    select: { slug: true },
  });

  if (!org || !project || !env) {
    throw new Error("Missing org/project/env from seed data");
  }

  const path = `/orgs/${org.slug}/projects/${project.slug}/env/${env.slug}/environment-variables`;
  const url = `${BASE_URL}${path}`;

  const presenter = new EnvironmentVariablesPresenter();
  const presenterData = await presenter.call({ userId: user.id, projectSlug: project.slug });
  const pageLoaderJson = JSON.stringify({
    environmentVariables: presenterData.environmentVariables,
    environments: presenterData.environments,
    hasStaging: presenterData.hasStaging,
    vercelIntegration: presenterData.vercelIntegration,
  });

  const cookie = await createSessionCookie(user.id);
  const res = await fetch(url, { headers: { Cookie: cookie } });
  const html = await res.text();

  const docBytes = Buffer.byteLength(html, "utf8");
  const remixContext = measureRemixContext(html);
  const tableBody = measureTableBody(html);
  const allTrCount = (html.match(/<tr\b/gi) ?? []).length;

  let envRouteLoaderBytes = 0;
  let allRoutesLoaderBytes = 0;
  let envRouteId = "";
  const remixMatch = html.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (remixMatch) {
    const ctx = JSON.parse(remixMatch[1]) as {
      state?: { loaderData?: Record<string, unknown> };
      loaderData?: Record<string, unknown>;
    };
    const routes = ctx.state?.loaderData ?? ctx.loaderData ?? {};
    for (const [id, data] of Object.entries(routes)) {
      const serialized = JSON.stringify(data);
      allRoutesLoaderBytes += Buffer.byteLength(serialized, "utf8");
      if (data && typeof data === "object" && "environmentVariables" in data) {
        envRouteId = id;
        const d = data as {
          environmentVariables: unknown;
          environments: unknown;
          hasStaging: unknown;
          vercelIntegration: unknown;
        };
        envRouteLoaderBytes = Buffer.byteLength(
          JSON.stringify({
            environmentVariables: d.environmentVariables,
            environments: d.environments,
            hasStaging: d.hasStaging,
            vercelIntegration: d.vercelIntegration,
          }),
          "utf8"
        );
      }
    }
  }

  const inputValues = [...html.matchAll(/<input[^>]*value="([^"]*)"/g)];
  const maskedInputs = inputValues.filter((m) => m[1]?.includes("•")).length;

  // Estimate env-vars slice inside embedded JSON (string search, approximate)
  const envVarKeyIdx = html.indexOf('"environmentVariables"');
  let envVarsJsonApprox = 0;
  if (envVarKeyIdx !== -1) {
    const slice = html.slice(envVarKeyIdx, envVarKeyIdx + pageLoaderJson.length + 500_000);
    envVarsJsonApprox = Math.min(slice.length, pageLoaderJson.length + 50_000);
  }

  console.log("\n=== Environment Variables page size breakdown ===\n");
  console.log(`URL: ${url}`);
  console.log(`HTTP: ${res.status}`);
  console.log(`Presenter rows: ${presenterData.environmentVariables.length}`);
  console.log("");
  console.log(`Total document:              ${formatMb(docBytes)}`);
  console.log(`Presenter page loader JSON:  ${formatMb(Buffer.byteLength(pageLoaderJson, "utf8"))}`);
  console.log(`Remix context script(s):     ${formatMb(remixContext.bytes)} (${remixContext.snippet})`);
  if (envRouteId) {
    console.log(`  env-vars route loader:     ${formatMb(envRouteLoaderBytes)} (route: ${envRouteId})`);
    console.log(`  all matched loaders sum:   ${formatMb(allRoutesLoaderBytes)}`);
  }
  console.log(`<tbody> markup:              ${formatMb(tableBody.bytes)} (${tableBody.trCount} <tr> in tbody)`);
  console.log(`All <tr> in document:        ${allTrCount}`);
  console.log(
    `Value <input> attrs:         ${inputValues.length} total, ${maskedInputs} masked (reveal off)`
  );
  console.log("");
  console.log(
    `Table share of document:     ${((tableBody.bytes / docBytes) * 100).toFixed(1)}% (tbody only)`
  );
  console.log(
    `Loader scripts share:        ${((remixContext.bytes / docBytes) * 100).toFixed(1)}% (all route scripts in remix context)`
  );
  const nonTableBytes = docBytes - tableBody.bytes;
  console.log(`Non-tbody document:          ${formatMb(nonTableBytes)} (shell + scripts + header)`);
  console.log("");
  console.log("=== SSR window estimate (50 rows, loader unchanged) ===\n");

  const rows = presenterData.environmentVariables.length;
  const ssrWindow = 50;
  const tbodyPerRow = tableBody.trCount > 0 ? tableBody.bytes / tableBody.trCount : 0;
  const estimatedTbody50 = tbodyPerRow * ssrWindow + 200; // header row in tbody if any
  const estimatedDoc50 = docBytes - tableBody.bytes + estimatedTbody50;

  console.log(`Per-row tbody bytes (measured): ${Math.round(tbodyPerRow).toLocaleString()} B`);
  console.log(`Estimated tbody @ 50 rows:        ${formatMb(estimatedTbody50)}`);
  console.log(`Estimated document @ 50 rows:   ${formatMb(estimatedDoc50)}`);
  console.log(
    `Document reduction factor:       ${(docBytes / estimatedDoc50).toFixed(1)}× (${(((docBytes - estimatedDoc50) / docBytes) * 100).toFixed(1)}% smaller)`
  );
  console.log(
    `Hydration row reduction:         ${tableBody.trCount} → ${ssrWindow} (${((1 - ssrWindow / tableBody.trCount) * 100).toFixed(1)}% fewer row components)`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
