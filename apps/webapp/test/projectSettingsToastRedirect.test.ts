// A flashed toast survives exactly one hop: the root loader reads it with `session.get`
// (which deletes the flash) and commits the emptied session, so any hop that runs the root
// loader spends the message — including a hop whose leaf loader only redirects again and
// never renders the toast. The general settings action must therefore redirect to a page
// that renders.

import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { commitSession, getSession, redirectWithErrorMessage } from "~/models/message.server";

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("~/models/organization.server", () => ({
  resolveOrgIdFromSlug: vi.fn().mockResolvedValue("org_1"),
}));

vi.mock("~/services/projectSettings.server", () => ({
  ProjectSettingsService: class {
    verifyProjectMembership() {
      return okAsync({ projectId: "proj_1" });
    }
  },
}));

const SETTINGS_PATH = "/orgs/o/projects/p/env/prod/settings/general";

// Mirrors the read in app/root.tsx's loader.
async function rootLoaderHop(cookie: string | null) {
  const session = await getSession(cookie);
  const toastMessage = session.get("toastMessage");
  return { toastMessage, setCookie: await commitSession(session) };
}

function asRequestCookie(setCookie: string) {
  return setCookie.split(";")[0];
}

async function denialRedirect(action: "rename" | "delete") {
  const module =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route");

  const body = new URLSearchParams(
    action === "rename" ? { action, projectName: "New name" } : { action, projectSlug: "p" }
  );

  try {
    await (module.action as any)({
      user: { id: "user_1" },
      ability: { can: () => false },
      request: new Request(`https://app.example.com${SETTINGS_PATH}`, { method: "POST", body }),
      params: { organizationSlug: "o", projectParam: "p", envParam: "prod" },
      context: {},
      searchParams: undefined,
    });
  } catch (thrown) {
    return thrown as Response;
  }

  throw new Error("expected the action to throw a redirect");
}

describe("toast flash through a redirect chain", () => {
  it("is lost when the redirect target redirects again", async () => {
    const request = new Request(`https://app.example.com${SETTINGS_PATH}`, { method: "POST" });
    const response = await redirectWithErrorMessage("/orgs/o/projects/p", request, "Denied");

    const projectRootHop = await rootLoaderHop(
      asRequestCookie(response.headers.get("Set-Cookie")!)
    );
    expect(projectRootHop.toastMessage?.message).toBe("Denied");

    const tasksPageHop = await rootLoaderHop(asRequestCookie(projectRootHop.setCookie));
    expect(tasksPageHop.toastMessage).toBeUndefined();
  });
});

describe("general settings permission denial", () => {
  it("redirects a denied rename back to the settings page with the message", async () => {
    const response = await denialRedirect("rename");

    expect(response.headers.get("Location")).toBe(SETTINGS_PATH);

    const hop = await rootLoaderHop(asRequestCookie(response.headers.get("Set-Cookie")!));
    expect(hop.toastMessage?.message).toBe("You don't have permission to rename this project");
  });

  it("redirects a denied delete back to the settings page with the message", async () => {
    const response = await denialRedirect("delete");

    expect(response.headers.get("Location")).toBe(SETTINGS_PATH);

    const hop = await rootLoaderHop(asRequestCookie(response.headers.get("Set-Cookie")!));
    expect(hop.toastMessage?.message).toBe("You don't have permission to delete this project");
  });
});
