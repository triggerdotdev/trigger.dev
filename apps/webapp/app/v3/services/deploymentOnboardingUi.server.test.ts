import { postgresTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { resolveDeploymentOnboardingUi } from "./deploymentOnboardingUi.server";

postgresTest(
  "flag off and unavailable storage skip project auth and onboarding reads for every environment",
  async ({ prisma, postgresContainer }) => {
    const org = await prisma.organization.create({
      data: { title: "Isolation", slug: "isolation", featureFlags: { deployNowEnabled: false } },
    });
    const request = new Request("http://localhost/deployments");
    const call = (
      environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
      client = prisma
    ) =>
      resolveDeploymentOnboardingUi({
        request,
        userId: "missing",
        organizationId: org.id,
        projectId: "missing",
        environmentId: "missing",
        organizationSlug: org.slug,
        projectSlug: "missing",
        environmentSlug: "missing",
        environmentType,
        url: new URL(request.url),
        client,
      });
    // No project/environment/user exists: onboarding must not touch those dependencies when off.
    for (const type of ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"] as const) {
      expect(await call(type)).toMatchObject({
        deployNowEnabled: false,
        canDeployNow: false,
        showGitHubOnboarding: false,
      });
    }
    const unavailableUrl = new URL(postgresContainer.getConnectionUri());
    unavailableUrl.searchParams.set("schema", "nonexistent_flag_test_schema");
    const unavailable = new PrismaClient({
      datasources: { db: { url: unavailableUrl.toString() } },
    });
    try {
      expect(await call("PRODUCTION", unavailable)).toMatchObject({
        deployNowEnabled: false,
        canDeployNow: false,
        showGitHubOnboarding: false,
      });
    } finally {
      await unavailable.$disconnect();
    }
    await prisma.organization.update({
      where: { id: org.id },
      data: { featureFlags: { deployNowEnabled: true } },
    });
    expect(await call("DEVELOPMENT")).toMatchObject({
      deployNowEnabled: true,
      canDeployNow: false,
      showGitHubOnboarding: false,
    });
  }
);

postgresTest(
  "disabled onboarding only reads activation data, including history and inspector URLs",
  async ({ prisma, postgresContainer }) => {
    const organization = await prisma.organization.create({
      data: {
        title: "Query boundary",
        slug: "query-boundary",
        featureFlags: { deployNowEnabled: false },
      },
    });
    const queries: string[] = [];
    const observed = new PrismaClient({
      datasources: { db: { url: postgresContainer.getConnectionUri() } },
      log: [{ level: "query", emit: "event" }],
    });
    observed.$on("query", (event) => queries.push(event.query));
    try {
      for (const environmentType of ["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"] as const) {
        for (const suffix of ["", "?view=history", "/dp_existing?page=1"]) {
          queries.length = 0;
          const url = new URL("http://localhost/deployments" + suffix);
          const result = await resolveDeploymentOnboardingUi({
            request: new Request(url),
            userId: "missing",
            organizationId: organization.id,
            projectId: "missing",
            environmentId: "missing",
            organizationSlug: organization.slug,
            projectSlug: "missing",
            environmentSlug: "missing",
            environmentType,
            url,
            deploymentParam: suffix.startsWith("/") ? "dp_existing" : undefined,
            client: observed,
          });
          expect(result).toMatchObject({
            deployNowEnabled: false,
            canDeployNow: false,
            showGitHubOnboarding: false,
            isPlatformConfigured: false,
          });
          expect(queries.length).toBeGreaterThan(0);
          for (const query of queries) {
            expect(query).toMatch(/^SELECT /);
            expect(query).toMatch(/"(?:Organization|FeatureFlag)"/);
            expect(query).not.toMatch(
              /"(?:WorkerDeployment|Project|ProjectIntegration|User|OrgMember)"/
            );
          }
        }
      }
    } finally {
      await observed.$disconnect();
    }
  }
);
