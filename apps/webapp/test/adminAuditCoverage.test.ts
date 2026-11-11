import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routesDir = path.join(__dirname, "../app/routes");

const EXPORT = /^export\s+(?:async\s+function|function|const)\s+(loader|action)\b(.*)$/gm;

function adminRouteFiles(): string[] {
  return readdirSync(routesDir).filter((name) => name.startsWith("admin.") && /\.tsx?$/.test(name));
}

/**
 * Admin routes are audited by wrapping their exports, so a route that forgets the wrapper is a
 * silent gap. Admin API loaders and actions must use `withAdminApi`, which audits and also refuses
 * the call when `ADMIN_API_ENABLED` is off; admin dashboard actions must use `withAdminAudit` or a
 * super-admin `dashboardAction`, which wraps itself.
 */
describe("admin audit coverage", () => {
  /**
   * Catches: a new or edited admin route whose loader or action skips the audit trail, or an
   * admin API route that stays reachable on an instance with the admin API turned off.
   */
  it("wraps every admin API export and every admin dashboard action", () => {
    const unaudited: string[] = [];

    for (const file of adminRouteFiles()) {
      const source = readFileSync(path.join(routesDir, file), "utf8");
      const isApi = file.startsWith("admin.api.");

      for (const match of source.matchAll(EXPORT)) {
        const [, name, rest] = match;
        if (!isApi && name === "loader") continue;

        const wrapped = rest
          .trimStart()
          .startsWith(isApi ? "= withAdminApi(" : "= withAdminAudit(");
        const superAdminDashboardAction =
          !isApi &&
          rest.trimStart().startsWith("= dashboardAction(") &&
          source.slice(match.index ?? 0, (match.index ?? 0) + 400).includes("requireSuper: true");

        if (!wrapped && !superAdminDashboardAction) {
          unaudited.push(`${file}: ${name}`);
        }
      }
    }

    expect(unaudited).toEqual([]);
  });
});
