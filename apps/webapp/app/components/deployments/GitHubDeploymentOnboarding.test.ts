import {
  ConnectedGitHubRepoForm,
  OnboardingConnectedGitHubRepoForm,
} from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";
import { GitHubBranchTracking } from "./GitHubBranchTracking";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { LocaleContextProvider } from "~/components/primitives/LocaleProvider";
import { expect, it } from "vitest";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { deployNowRequestError, GitHubDeploymentOnboarding } from "./GitHubDeploymentOnboarding";
import { OnboardingDeploymentLogs } from "./OnboardingDeploymentLogs";

function render(node: React.ReactNode) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(LocaleContextProvider, { locales: ["en-GB"] }, node)
        )
      ),
    },
  ]);
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
function panel(props: Partial<ComponentProps<typeof GitHubDeploymentOnboarding>> = {}) {
  return render(
    createElement(GitHubDeploymentOnboarding, {
      connection: "Repository connected",
      branch: "release/test",
      canDeploy: true,
      deployAction: createElement("button", null, "Deploy now"),
      ...props,
    })
  );
}

it("hides Deploy now without write permission or a tracked branch, independently of the RBAC plugin", () => {
  expect(panel()).toContain("Deploy now");
  expect(panel({ canDeploy: false })).not.toContain("Deploy now");
  expect(panel({ branch: undefined })).not.toContain("Deploy now");
  expect(panel({ canDeploy: false })).toContain("release/test");
});

it("replaces standalone deploy instructions with the Vercel release action for atomic production", () => {
  const html = panel({ atomicVercelUrl: "https://vercel.com/team/app" });
  expect(html).toContain("This project releases its app and tasks together through Vercel.");
  expect(html).toContain("Open Vercel");
  expect(html).toContain('href="https://vercel.com/team/app"');
  expect(html).not.toContain("Deploy now");
  expect(html).not.toContain("Deploy the latest commit");
});

it("shows persisted progress and diagnostics instead of another deploy action", () => {
  for (const status of [
    "PENDING",
    "INSTALLING",
    "BUILDING",
    "DEPLOYING",
    "FAILED",
    "CANCELED",
    "TIMED_OUT",
  ] as const) {
    const html = panel({
      build: {
        shortCode: "dp_selected",
        status,
        href: "/deployment/dp_selected",
        errorMessage: status === "FAILED" ? "Build failed: missing key" : undefined,
      },
      logs: "Selected build logs",
      historyHref: "/deployments?view=history",
    });
    expect(html).not.toContain("Deploy now");
    expect(html).toContain("/deployment/dp_selected");
    expect(html).toContain("Selected build logs");
    expect(html).toContain("All deployments");
    if (status === "FAILED") expect(html).toContain("Build failed: missing key");
  }
});

it("keeps submission failures actionable and renders buffered logs alongside disconnect errors", () => {
  expect(panel({ requestError: "Couldn't start" })).toContain("Deploy now");
  const props = {
    logs: [
      {
        timestamp: new Date("2026-09-15T00:00:00Z"),
        message: "Retained build log",
        level: "error" as const,
      },
    ],
    isStreaming: false,
    streamError: "Disconnected. Reload logs.",
  };
  for (const compact of [true, false]) {
    const html = render(createElement(OnboardingDeploymentLogs, { ...props, compact }));
    expect(html).toContain("Retained build log");
    expect(html).toContain("Disconnected. Reload logs.");
    expect(html).toContain("Copy logs");
    expect(html).toContain(compact ? "h-48" : "h-64");
  }
});

it("requires saving branch edits before the deployment action can be used", () => {
  const html = panel({ settingsDirty: true });
  expect(html).toContain('<fieldset disabled="">');
  expect(html).not.toContain("Save your branch settings before deploying.");
  expect(panel({ settingsDirty: false })).not.toContain('<fieldset disabled="">');
});

it("shows available environment controls and upgrade actions independently", () => {
  for (const stagingEnabled of [true, false]) {
    for (const previewEnabled of [true, false]) {
      const html = render(
        createElement(GitHubBranchTracking, {
          productionInput: createElement("input", {
            name: "productionBranch",
            defaultValue: "main",
          }),
          stagingInput: createElement("input", { name: "stagingBranch", defaultValue: "staging" }),
          previewInput: createElement(
            "button",
            { role: "switch", "aria-checked": true },
            "Preview control"
          ),
          stagingEnvironmentEnabled: stagingEnabled,
          previewEnvironmentEnabled: previewEnabled,
          previewDeploymentsEnabled: false,
          billingPath: "/billing",
          saveAction: createElement("button", null, "Save"),
        })
      );
      expect(html).toContain('name="productionBranch"');
      expect(html.includes('name="stagingBranch"')).toBe(stagingEnabled);
      expect(html.includes('role="switch"')).toBe(previewEnabled);
      expect((html.match(/href="\/billing"/g) ?? []).length).toBe(
        Number(!stagingEnabled) + Number(!previewEnabled)
      );
      expect(html).toContain("Save");
    }
  }
});

it("preserves an existing preview setting when the preview environment is unavailable", () => {
  const html = render(
    createElement(GitHubBranchTracking, {
      productionInput: null,
      stagingInput: null,
      previewInput: null,
      stagingEnvironmentEnabled: false,
      previewEnvironmentEnabled: false,
      previewDeploymentsEnabled: true,
      billingPath: "/billing",
      saveAction: null,
    })
  );
  expect(html).toContain('type="hidden" name="previewDeploymentsEnabled" value="on"');
});

it("wires the real connected-repository form into the existing save endpoint", () => {
  for (const autosave of [false, true]) {
    const html = render(
      createElement(OnboardingConnectedGitHubRepoForm, {
        connectedGitHubRepo: {
          branchTracking: { prod: { branch: "main" }, staging: { branch: "staging" } },
          previewDeploymentsEnabled: true,
          createdAt: new Date("2026-09-15T00:00:00Z"),
          repository: {
            id: "repo",
            name: "tasks",
            fullName: "org/tasks",
            private: true,
            htmlUrl: "https://example.test/org/tasks",
          },
        },
        previewEnvironmentEnabled: true,
        stagingEnvironmentEnabled: true,
        organizationSlug: "org",
        projectSlug: "project",
        environmentSlug: "prod",
        billingPath: "/billing",
        redirectUrl: "/orgs/org/projects/project/env/prod/deployments",
        showRepositoryDetails: false,
        autosave,
        canManageGithub: false,
      })
    );
    expect(html).toContain('action="/resources/orgs/org/projects/project/env/prod/github"');
    expect(html).toContain('name="productionBranch"');
    expect(html).toContain('name="stagingBranch"');
    expect(html).toContain('name="previewDeploymentsEnabled"');
    expect(html).toContain('value="update-git-settings"');
    expect(html).toContain('value="/orgs/org/projects/project/env/prod/deployments"');
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain("Upgrade");
    expect((html.match(/ disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(autosave ? 3 : 4);
    expect(html.includes(">Save<")).toBe(!autosave);
  }
});

it("places request errors below the description and build errors below log guidance", () => {
  const request = panel({ requestError: "Request failed" });
  expect(request.indexOf("Request failed")).toBeGreaterThan(
    request.indexOf("Deploy the latest commit")
  );
  const failed = panel({
    build: {
      shortCode: "dp_fail",
      status: "FAILED",
      href: "/deployment",
      errorMessage: "Missing key",
    },
    buildErrors: ["Missing key", "Invalid config"],
  });
  expect(failed.indexOf("Check the build logs")).toBeLessThan(failed.indexOf("Missing key"));
  expect(failed.match(/Missing key/g)).toHaveLength(1);
  expect(failed).toContain("rounded-full bg-error");
  expect(failed).toMatch(/text-error[^>]*>Your deployment failed/);
});

it("gives Preview parent and disabled branch environments actionable guidance", () => {
  const parent = panel({ branch: undefined, previewEnvironment: true, previewParent: true });
  expect(parent).toContain("push to a branch to create its preview environment");
  expect(parent).not.toContain("Deploy now");
  expect(parent).not.toContain("choose a tracked branch");
  expect(
    panel({ branch: undefined, repositoryConnected: true, previewEnvironment: true })
  ).toContain("Enable preview deployments in GitHub settings to deploy this branch");
});

it("keeps the legacy connected-repository form on its original layout and explicit Save", () => {
  for (const canManageGithub of [false, true]) {
    const html = render(
      createElement(ConnectedGitHubRepoForm, {
        connectedGitHubRepo: {
          branchTracking: { prod: { branch: "main" }, staging: { branch: "staging" } },
          previewDeploymentsEnabled: true,
          createdAt: new Date("2026-09-15T00:00:00Z"),
          repository: {
            id: "repo",
            name: "tasks",
            fullName: "org/tasks",
            private: true,
            htmlUrl: "https://example.test/org/tasks",
          },
        },
        previewEnvironmentEnabled: true,
        stagingEnvironmentEnabled: true,
        organizationSlug: "org",
        projectSlug: "project",
        environmentSlug: "prod",
        billingPath: "/billing",
        redirectUrl: "/orgs/org/projects/project/env/prod/deployments",
        canManageGithub,
      })
    );
    expect(html).toContain('action="/resources/orgs/org/projects/project/env/prod/github"');
    expect(html).toContain('name="productionBranch"');
    expect(html).toContain('name="stagingBranch"');
    expect(html).toContain('name="previewDeploymentsEnabled"');
    expect(html).toContain('value="update-git-settings"');
    expect(html).toContain('value="/orgs/org/projects/project/env/prod/deployments"');
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("github-branch-tracking");
    expect(html).not.toContain("text-balance");
    expect(html).not.toContain("Upgrade");
    if (!canManageGithub)
      expect((html.match(/ disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html.includes(">Save<")).toBe(true);
  }
});

it("tells the user a missing branch has to be pushed instead of asking them to retry", () => {
  const missing = 'The branch "test" doesn\'t exist in acme/app. Push it to GitHub, then deploy.';
  expect(deployNowRequestError({ code: "BRANCH_NOT_FOUND", error: missing })).toBe(missing);
  expect(deployNowRequestError({ error: "Couldn't start the deploy" })).toBe(
    "Couldn't start the deployment. Try again."
  );
});
