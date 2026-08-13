// A flashed toast survives exactly one hop: the root loader reads it with `session.get`
// (which deletes the flash) and commits the emptied session, so any hop that runs the root
// loader spends the message — including a hop whose leaf loader only redirects again and
// never renders the toast. The general settings action must therefore redirect to a page
// that renders.

import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { commitSession, getSession, redirectWithErrorMessage } from "~/models/message.server";
import {
  action as generalSettingsAction,
  submissionFor,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route";

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("~/models/organization.server", () => ({
  resolveOrgIdFromSlug: vi.fn().mockResolvedValue("org_1"),
}));

const renameFails = { value: false };

vi.mock("~/services/projectSettings.server", () => ({
  ProjectSettingsService: class {
    verifyProjectMembership() {
      return okAsync({ projectId: "proj_1" });
    }
    renameProject() {
      return renameFails.value ? errAsync({ type: "other" as const }) : okAsync(undefined);
    }
    deleteProject() {
      return okAsync(undefined);
    }
  },
}));

const SETTINGS_PATH = "/orgs/o/projects/p/env/prod/settings/general";
const ORG_PATH = "/orgs/o";

// Mirrors the read in app/root.tsx's loader.
async function rootLoaderHop(cookie: string | null) {
  const session = await getSession(cookie);
  const toastMessage = session.get("toastMessage");
  return { toastMessage, setCookie: await commitSession(session) };
}

function asRequestCookie(setCookie: string) {
  return setCookie.split(";")[0];
}

async function runAction(action: "rename" | "delete", allowed: boolean) {
  const body = new URLSearchParams(
    action === "rename" ? { action, projectName: "New name" } : { action, projectSlug: "p" }
  );

  try {
    return (await (generalSettingsAction as any)({
      user: { id: "user_1" },
      ability: { can: () => allowed },
      request: new Request(`https://app.example.com${SETTINGS_PATH}`, { method: "POST", body }),
      params: { organizationSlug: "o", projectParam: "p", envParam: "prod" },
      context: {},
      searchParams: undefined,
    })) as Response;
  } catch (thrown) {
    return thrown as Response;
  }
}

async function toastFor(response: Response) {
  const hop = await rootLoaderHop(asRequestCookie(response.headers.get("Set-Cookie")!));
  return hop.toastMessage?.message;
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

describe("general settings redirects target a page that renders", () => {
  it("sends a denied rename back to the settings page with the message", async () => {
    const response = await runAction("rename", false);

    expect(response.headers.get("Location")).toBe(SETTINGS_PATH);
    expect(await toastFor(response)).toBe("You don't have permission to rename this project");
  });

  it("sends a denied delete back to the settings page with the message", async () => {
    const response = await runAction("delete", false);

    expect(response.headers.get("Location")).toBe(SETTINGS_PATH);
    expect(await toastFor(response)).toBe("You don't have permission to delete this project");
  });

  // The deleted project's settings page is gone and no org-level page renders, so a
  // successful delete keeps its original destination and its message is not shown.
  it("leaves a successful delete pointed at the organization root", async () => {
    const response = await runAction("delete", true);

    expect(response.headers.get("Location")).toBe(ORG_PATH);
  });
});

describe("general settings failures reach the form", () => {
  it("returns a form-level error when the rename fails", async () => {
    renameFails.value = true;
    const response = await runAction("rename", true);
    renameFails.value = false;

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { "": ["Failed to rename project"] },
    });
  });

  // A SubmissionResult carries no form identity, so both forms would otherwise show it.
  it("scopes the rename failure to the rename form", async () => {
    renameFails.value = true;
    const response = await runAction("rename", true);
    renameFails.value = false;

    const result = await response.json();

    expect(submissionFor(result, "rename")).toEqual(result);
    expect(submissionFor(result, "delete")).toBeUndefined();
  });
});
