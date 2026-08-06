import ts from "@typescript/typescript6";
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
 * Every name and every path segment the tool matches on must exist in the codebase it is pointed at.
 * Half of `SENSITIVE_SYMBOLS` named nothing before this test, and the guard list has the same failure
 * mode with a worse consequence: a guard name resolving nowhere makes a route that can never pass.
 *
 * Checked: every guard name and sensitive symbol is DECLARED under one of `ROOTS`, as a function,
 * class, interface, type, enum, variable or member name; members count because several guards are
 * reached through an object and `calleeName` records the property. And every sensitive path segment
 * appears as a segment of a real route file name.
 *
 * Not checked, each a place a wrong entry can hide: that the declaration found is the one meant, that
 * a guard actually guards, and anything outside `ROOTS`.
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
 * Guard names declared by a dependency rather than by us, and therefore deliberately unchecked. Both
 * are remix-auth's, and resolving them meant reading a path inside `apps/webapp/node_modules`, which
 * an install-layout change turns into a confusing environmental failure. Listing them is a smaller
 * claim honestly made: the test still fails on a name that is neither first-party nor listed.
 */
const EXTERNAL_GUARDS = new Set(["authenticate", "isAuthenticated"]);

/** Two is the number of remix-auth methods on the guard list. A third entry means someone widened
 * the unchecked set, which is the thing this bound exists to make visible in review. */
const MAX_EXTERNAL_GUARDS = 2;

const ROUTES = resolve(REPO, "apps/webapp/app/routes");

/** A tree this package owns, for proving the walkers can answer no. Proving that on the live tree
 * meant asserting nobody in the webapp ever declares certain names, even as a local variable. */
const FIXTURES = resolve(__dirname, "../fixtures/webappSymbols");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (isScannableFile(entry.name)) out.push(path);
  }
  return out;
}

function declaredNames(roots: string[]): Set<string> {
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

  const files = roots.flatMap((root) => walkFiles(root));
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
function routeSegments(dir: string): Set<string> {
  const segments = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
  const declared = declaredNames(ROOTS);
  const segments = routeSegments(ROUTES);

  it("found a codebase to check against", () => {
    expect(declared.size).toBeGreaterThan(5000);
    expect(segments.size).toBeGreaterThan(100);
  });

  it("every sensitive symbol is declared somewhere", () => {
    expect(
      SENSITIVE_SYMBOLS.filter((s) => !declared.has(s)),
      "renamed or removed? update SENSITIVE_SYMBOLS in " +
        "internal-packages/observability-map/src/sensitivity.ts in the same PR"
    ).toEqual([]);
  });

  // The list this test did not cover, and it had rotted completely: all three of `auditLog`,
  // `recordAudit` and `writeAuditEvent` were exported nowhere, so `audit-trail`'s pass branch could
  // not fire and the report said "No audit helper exists in the webapp" while
  // `models/admin.server.ts` was writing `impersonationAuditLog` rows on two paths.
  it("every audit symbol is declared somewhere", () => {
    expect(
      AUDIT_SYMBOLS.filter((s) => !declared.has(s)),
      "renamed or removed? update AUDIT_SYMBOLS in " +
        "internal-packages/observability-map/src/checks/auditTrail.ts in the same PR"
    ).toEqual([]);
  });

  it("every auth guard is declared somewhere, or is a listed dependency method", () => {
    const names = [...GUARDS, ...SOFT_GUARDS];
    expect(
      names.filter((g) => !declared.has(g) && !EXTERNAL_GUARDS.has(g)),
      "renamed or removed? update GUARDS or SOFT_GUARDS in " +
        "internal-packages/observability-map/src/checks/authBoundary.ts in the same PR"
    ).toEqual([]);
  });

  // The escape hatch is only worth having while it stays small.
  it("keeps the unchecked guard names to the two remix-auth methods", () => {
    expect(EXTERNAL_GUARDS.size).toBeLessThanOrEqual(MAX_EXTERNAL_GUARDS);
    expect([...EXTERNAL_GUARDS].filter((g) => !GUARDS.has(g))).toEqual([]);
  });

  it("every sensitive path segment names a real route segment", () => {
    const live = SENSITIVE_SEGMENTS.filter((s) => !ANTICIPATED_SEGMENTS.includes(s));
    expect(
      live.filter((s) => !segments.has(s)),
      "renamed or removed the last route with this segment? update SENSITIVE_SEGMENTS in " +
        "internal-packages/observability-map/src/sensitivity.ts in the same PR"
    ).toEqual([]);
  });

  // The escape hatch is only worth having while it is small and honest about itself. Kept required
  // rather than moved to the nightly on purpose: the PR adding the first such route is the one whose
  // author knows the route exists, and the segment is scored sensitive either way.
  it("every anticipated segment really does name nothing yet", () => {
    expect(
      ANTICIPATED_SEGMENTS.filter((s) => segments.has(s)),
      "added the first route with this segment? move it from ANTICIPATED_SEGMENTS into the live " +
        "list in internal-packages/observability-map/src/sensitivity.ts in the same PR"
    ).toEqual([]);
  });

  // The checker has to be able to fail. Proven on the fixture tree rather than the live one, which
  // is where the earlier version of these tests asserted that no webapp file declares `createJWT`
  // even as a local variable, and failed this suite on any pull request that did.
  it("finds a fixture name however it is declared, and rejects one that is only read", () => {
    const names = declaredNames([join(FIXTURES, "app")]);
    // A name per declaration form, so no branch of the walker is covered only by another's name:
    // deleting any one of the three fails here rather than in the live-tree assertions this fixture
    // exists to replace.
    expect(names.has("helper")).toBe(true);
    expect(names.has("createJWT")).toBe(true);
    expect(names.has("mintSessionToken")).toBe(true);
    expect(names.has("signJWT")).toBe(false);
  });

  it("finds a fixture route segment, and rejects the segment's own substring", () => {
    const fixtureSegments = routeSegments(join(FIXTURES, "routes"));
    expect(fixtureSegments.has("secrets")).toBe(true);
    expect(fixtureSegments.has("secret")).toBe(false);
  });
});
