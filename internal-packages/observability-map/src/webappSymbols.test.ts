import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AUDIT_SYMBOLS } from "./checks/auditTrail.js";
import { GUARDS, SOFT_GUARDS } from "./checks/authBoundary.js";
import { isScannableFile } from "./scan.js";
import {
  ANTICIPATED_SEGMENTS,
  normalizeSegment,
  SENSITIVE_SEGMENTS,
  SENSITIVE_SYMBOLS,
} from "./sensitivity.js";

/**
 * Every name and every path segment the tool matches on must exist in the codebase it is pointed
 * at.
 *
 * This is the test the last round did not have, and the cost of not having it was measured: half of
 * `SENSITIVE_SYMBOLS` named nothing. `Set.has` is exact, so `setImpersonation`, `createJWT`,
 * `signJWT` and `updateEnvVars` matched no route in the tree, while `startImpersonation`, the real
 * escalation, was absent from the list. Nothing failed, nothing was reported, and the symbol half
 * of the classifier was quietly doing almost nothing. `auth-boundary`'s guard list has the same
 * failure mode with a worse consequence, since a guard name that resolves to nothing turns into a
 * route that can never pass rather than a route that can never fail.
 *
 * What is checked:
 *
 * - every guard name and every sensitive symbol is DECLARED somewhere under one of `ROOTS`. A
 *   declaration is a function, class, interface, type, enum or variable name, or a member name on a
 *   class, interface or object literal. Members count because several guards are reached through an
 *   object: `rbac.authenticateSession`, `authenticator.isAuthenticated`, and `calleeName` in
 *   `scan.ts` records the property for a member call, so that is the form the check sees.
 * - every sensitive path segment appears as a segment of a real route file name.
 *
 * What is NOT checked, and each is a place a wrong entry can still hide:
 *
 * - that the declaration found is the one meant. `authenticateAdmin` is a local helper inside
 *   `admin.api.v1.platform-notifications.ts`; a second route declaring its own no-op function of
 *   that name would be credited by `auth-boundary`. Names cannot carry that guarantee, and the
 *   alternative, a module-resolving import graph, is a different kind of analysis from anything
 *   else in this package.
 * - that a guard actually guards. `resolveAuthenticatedEnv` declares fine and authenticates
 *   nothing, which is why it is not on the list; keeping it off is a hand-read judgement this test
 *   cannot make.
 * - anything outside `ROOTS`. A guard declared only by a dependency is listed in
 *   `EXTERNAL_GUARDS` and not resolved at all; see the comment there for why that is a list
 *   rather than a path into `node_modules`.
 */

const REPO = resolve(__dirname, "../../..");

/**
 * Where a guard or a sensitive symbol may be declared. The webapp first, then the two packages it
 * authenticates through: `packages/plugins` declares the RBAC controller interface the dashboard
 * and PAT builders call, and `internal-packages/rbac` declares its fallback and the user-actor
 * token verifier that three routes import directly.
 */
const ROOTS = [
  resolve(REPO, "apps/webapp/app"),
  resolve(REPO, "packages/plugins/src"),
  resolve(REPO, "internal-packages/rbac/src"),
];

/**
 * Guard names declared by a dependency rather than by us, and therefore deliberately unchecked.
 *
 * Both are methods on remix-auth's `Authenticator`, reached as `authenticator.authenticate(...)`
 * and `authenticator.isAuthenticated(...)`; the whole login surface is built on them. An earlier
 * version of this test resolved them by reading
 * `apps/webapp/node_modules/remix-auth/build/authenticator.d.ts` directly. That is a path into an
 * installed tree: a hoisting change, a version bump that moves `build/`, or a fresh clone with a
 * different install layout turns a real assertion into a confusing environmental failure, and a
 * test that fails for environmental reasons teaches people to ignore it.
 *
 * So they are listed instead, which is a smaller claim honestly made. The test still fails if a
 * guard name is neither declared in first-party source nor on this list, so a name that resolves
 * nowhere cannot be added silently; what it no longer does is prove these two exist.
 */
const EXTERNAL_GUARDS = new Set(["authenticate", "isAuthenticated"]);

/** Two is the number of remix-auth methods on the guard list. A third entry means someone widened
 * the unchecked set, which is the thing this bound exists to make visible in review. */
const MAX_EXTERNAL_GUARDS = 2;

const ROUTES = resolve(REPO, "apps/webapp/app/routes");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (isScannableFile(entry.name)) out.push(path);
  }
  return out;
}

function declaredNames(): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBinding(element.name);
    }
  };

  const files = ROOTS.flatMap((root) => walkFiles(root));
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name);
      else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name
      ) {
        names.add(node.name.text);
      } else if (
        (ts.isMethodDeclaration(node) ||
          ts.isMethodSignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertySignature(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return names;
}

/** Every dot-separated piece of every route name, flat file or directory, e.g. `billing-limits`. */
function routeSegments(): Set<string> {
  const segments = new Set<string>();
  for (const entry of readdirSync(ROUTES, { withFileTypes: true })) {
    for (const part of entry.name.replace(/\.tsx?$/, "").split(".")) {
      // `sensitivity.ts`'s own normalizer. This validates the vocabulary that file matches on, so
      // a segment has to be trimmed here exactly as it is trimmed there; the local `/_+$/` was
      // also the regex `normalizeSegment`'s own comment says not to use.
      segments.add(normalizeSegment(part));
    }
  }
  return segments;
}

describe("the names the tool matches on exist in the webapp", () => {
  const declared = declaredNames();
  const segments = routeSegments();

  it("found a codebase to check against", () => {
    expect(declared.size).toBeGreaterThan(5000);
    expect(segments.size).toBeGreaterThan(100);
  });

  it("every sensitive symbol is declared somewhere", () => {
    expect(SENSITIVE_SYMBOLS.filter((s) => !declared.has(s))).toEqual([]);
  });

  // The list this test did not cover, and it had rotted completely: all three of `auditLog`,
  // `recordAudit` and `writeAuditEvent` were exported nowhere, so `audit-trail`'s pass branch could
  // not fire and the report said "No audit helper exists in the webapp" while
  // `models/admin.server.ts` was writing `impersonationAuditLog` rows on two paths.
  it("every audit symbol is declared somewhere", () => {
    expect(AUDIT_SYMBOLS.filter((s) => !declared.has(s))).toEqual([]);
  });

  it("every auth guard is declared somewhere, or is a listed dependency method", () => {
    const names = [...GUARDS, ...SOFT_GUARDS];
    expect(names.filter((g) => !declared.has(g) && !EXTERNAL_GUARDS.has(g))).toEqual([]);
  });

  // The escape hatch is only worth having while it stays small.
  it("keeps the unchecked guard names to the two remix-auth methods", () => {
    expect(EXTERNAL_GUARDS.size).toBeLessThanOrEqual(MAX_EXTERNAL_GUARDS);
    expect([...EXTERNAL_GUARDS].filter((g) => !GUARDS.has(g))).toEqual([]);
  });

  it("every sensitive path segment names a real route segment", () => {
    const live = SENSITIVE_SEGMENTS.filter((s) => !ANTICIPATED_SEGMENTS.includes(s));
    expect(live.filter((s) => !segments.has(s))).toEqual([]);
  });

  // The escape hatch is only worth having while it is small and honest about itself.
  it("every anticipated segment really does name nothing yet", () => {
    expect(ANTICIPATED_SEGMENTS.filter((s) => segments.has(s))).toEqual([]);
  });

  // The checker has to be able to fail. These run the same predicates over the names the last round
  // shipped, which is what the test exists to have caught.
  it("would reject the symbols that named nothing", () => {
    for (const dead of ["setImpersonation", "createJWT", "signJWT", "updateEnvVars"]) {
      expect(declared.has(dead)).toBe(false);
    }
  });

  it("would reject a guard name and a path segment that name nothing", () => {
    expect(declared.has("requireNothingAtAll")).toBe(false);
    expect(EXTERNAL_GUARDS.has("requireNothingAtAll")).toBe(false);
    expect(segments.has("no-such-route-segment")).toBe(false);
  });
});
