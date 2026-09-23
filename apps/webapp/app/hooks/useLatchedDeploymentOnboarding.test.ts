// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router-dom";
import { expect, it } from "vitest";
import { useLatchedDeploymentOnboarding } from "./useLatchedDeploymentOnboarding";

type PageState = {
  showGitHubOnboarding: boolean;
  onboardingDetails?: { deployment: { shortCode: string; status: "BUILDING" | "DEPLOYING" } };
};

it("keeps the first build on screen once it deploys, until the user navigates", async () => {
  let pageState: PageState = {
    showGitHubOnboarding: true,
    onboardingDetails: { deployment: { shortCode: "abc", status: "BUILDING" } },
  };
  let finalStatus = "DEPLOYING";
  let rendered: ReturnType<typeof useLatchedDeploymentOnboarding<PageState>> | undefined;

  function Page() {
    const data = useLoaderData() as PageState;
    const current = useLatchedDeploymentOnboarding(data, {
      deploymentPath: (shortCode) => `/deployments/${shortCode}`,
      pollIntervalMs: 20,
    });
    useEffect(() => {
      rendered = current;
    });
    return null;
  }

  const router = createMemoryRouter(
    [
      { path: "/deployments", loader: () => pageState, element: createElement(Page) },
      {
        path: "/deployments/:shortCode",
        loader: ({ params }) => ({
          deployment: { shortCode: params.shortCode, status: finalStatus, errorData: null },
        }),
        element: null,
      },
    ],
    { initialEntries: ["/deployments"] }
  );
  const root = createRoot(document.createElement("div"));
  async function until(check: () => void) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      try {
        check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
  }

  try {
    await act(async () => {
      root.render(createElement(RouterProvider, { router }));
    });
    await until(() => expect(rendered).toMatchObject({ latched: false, onboarding: pageState }));

    // The build succeeds: the loader stops selecting onboarding.
    pageState = { showGitHubOnboarding: false };
    await act(async () => router.revalidate());
    await until(() =>
      expect(rendered).toMatchObject({
        latched: true,
        onboarding: {
          showGitHubOnboarding: true,
          onboardingDetails: { deployment: { shortCode: "abc", status: "DEPLOYING" } },
        },
      })
    );

    // Polls the build until it reaches a final status.
    finalStatus = "DEPLOYED";
    await until(() =>
      expect(rendered?.onboarding?.onboardingDetails?.deployment.status).toBe("DEPLOYED")
    );

    await act(async () => router.navigate("/deployments?view=history"));
    await until(() =>
      expect(rendered).toEqual({ latched: false, onboarding: { showGitHubOnboarding: false } })
    );
  } finally {
    await act(async () => root.unmount());
  }
});
