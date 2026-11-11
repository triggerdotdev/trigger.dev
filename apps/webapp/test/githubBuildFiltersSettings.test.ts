import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import * as webappRouteMocks from "./helpers/webappRouteMocks";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => {
  Object.assign(process.env, {
    GITHUB_APP_ENABLED: "1",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    GITHUB_APP_WEBHOOK_SECRET: "test-webhook-secret",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_IGNORED_PATHS_LIMIT: "4",
    GITHUB_IGNORED_PATH_MAX_LENGTH: "40",
  });
  return { prisma: undefined as unknown as PrismaClient, userId: "" };
});

vi.mock("~/db.server", () => webappRouteMocks.dbServerProxyMock(holder));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (_options: unknown, handler: any) => (args: any) =>
    handler({ ...args, user: { id: holder.userId } });
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

import { saveGitSettings } from "~/components/deployments/gitSettingsAutosave";
import { GitHubSettingsPresenter } from "~/presenters/v3/GitHubSettingsPresenter.server";
import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.github";

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(
  prisma: PrismaClient,
  buildFilters?: { ignorePaths?: string[]; ignoreBranches?: string[] }
) {
  holder.prisma = prisma;
  const slug = `ignored_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  holder.userId = user.id;
  const organization = await prisma.organization.create({
    data: {
      title: slug,
      slug,
      featureFlags: { deployNowEnabled: true },
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  for (const type of ["PRODUCTION", "PREVIEW"] as const) {
    await prisma.runtimeEnvironment.create({
      data: {
        slug: type === "PRODUCTION" ? "prod" : "preview",
        type,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${type}_${slug}`,
        pkApiKey: `pk_${type}_${slug}`,
        shortcode: `${type}${suffix()}`,
      },
    });
  }
  const installation = await prisma.githubAppInstallation.create({
    data: {
      appInstallationId: BigInt(Math.floor(Math.random() * 1_000_000_000)),
      targetId: 1n,
      targetType: "Organization",
      accountHandle: slug,
      repositorySelection: "ALL",
      organizationId: organization.id,
    },
  });
  const repository = await prisma.githubRepository.create({
    data: {
      githubId: 1n,
      name: slug,
      fullName: `acme/${slug}`,
      htmlUrl: `https://github.com/acme/${slug}`,
      private: true,
      defaultBranch: "main",
      installationId: installation.id,
    },
  });
  await prisma.connectedGithubRepository.create({
    data: {
      projectId: project.id,
      repositoryId: repository.id,
      branchTracking: { prod: { branch: "main" }, staging: {} },
      previewDeploymentsEnabled: true,
      buildFilters,
    },
  });
  return {
    organization,
    project,
    path: `/resources/orgs/${slug}/projects/${slug}/env/prod/github`,
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function runAction(seeded: Seeded, request: Request) {
  return (action as any)({
    request,
    params: {
      organizationSlug: seeded.organization.slug,
      projectParam: seeded.project.slug,
      envParam: "prod",
    },
    context: {},
  }) as Promise<Response>;
}

function submitSettings(seeded: Seeded, fields: { ignorePaths?: string; ignoreBranches?: string }) {
  const body = new FormData();
  body.set("action", "update-git-settings");
  body.set("productionBranch", "main");
  body.set("previewDeploymentsEnabled", "on");
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return runAction(seeded, new Request(`http://localhost${seeded.path}`, { method: "POST", body }));
}

async function storedRepo(prisma: PrismaClient, projectId: string) {
  return prisma.connectedGithubRepository.findFirstOrThrow({
    where: { projectId },
    select: { buildFilters: true, previewDeploymentsEnabled: true },
  });
}

async function presented(seeded: Seeded) {
  const result = await new GitHubSettingsPresenter().call({
    projectId: seeded.project.id,
    organizationId: seeded.organization.id,
  });
  return result._unsafeUnwrap();
}

describe("ignored paths in the Git settings action", () => {
  postgresTest(
    "stores one trimmed pattern per non-blank line and presents them back",
    async ({ prisma }) => {
      const seeded = await seed(prisma);

      const response = await submitSettings(seeded, {
        ignorePaths: "  docs/**  \n\n.github/**\r\n\t*.md\napp/\\(marketing\\)/**\n",
      });

      expect(response.status).toBe(302);
      const buildFilters = {
        ignorePaths: ["docs/**", ".github/**", "*.md", "app/\\(marketing\\)/**"],
        ignoreBranches: [],
      };
      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual(buildFilters);
      expect((await presented(seeded)).connectedRepository?.buildFilters).toEqual(buildFilters);
    }
  );

  postgresTest(
    "clears the stored patterns when the field is submitted empty",
    async ({ prisma }) => {
      const seeded = await seed(prisma, { ignorePaths: ["docs/**"] });

      await submitSettings(seeded, { ignorePaths: "\n  \n" });

      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual({
        ignorePaths: [],
        ignoreBranches: [],
      });
    }
  );

  postgresTest(
    "rejects a bad pattern with a field error and keeps the stored patterns",
    async ({ prisma }) => {
      const seeded = await seed(prisma, { ignorePaths: ["docs/**"] });

      for (const [pattern, message] of [
        ["!src/**", "!src/**: Negated patterns aren't supported. List only the paths to ignore."],
        [
          "!(src)/**",
          "!(src)/**: Negated patterns aren't supported. List only the paths to ignore.",
        ],
        ["/docs/**", "/docs/**: Start from the repository root, without a leading slash."],
        ["docs/", "docs/: Matches no files. Use docs/** for everything in the directory."],
        ["src/[z-a]/*.ts", "src/[z-a]/*.ts: Not a valid glob pattern."],
        ["a".repeat(41), `${"a".repeat(41)}: Use at most 40 characters.`],
        [
          "**/*.{md,mdx}",
          "**/*.{md,mdx}: Braces aren't supported. Put each alternative on its own line.",
        ],
        [
          "app/(marketing)/**",
          "app/(marketing)/**: Escape ( ) and | with a backslash to match them, like app/\\(marketing\\)/**.",
        ],
        ["**/a/**/b/**", "**/a/**/b/**: Use ** at most twice."],
        ["src/*a*b*.ts", "src/*a*b*.ts: Use * at most twice, apart from **."],
        ["*a*/*a*/b", "*a*/*a*/b: Use * at most twice, apart from **."],
        ["a\\/**\\/a/**/b/**", "a\\/**\\/a/**/b/**: Use ** at most twice."],
        ["src/[!_]*.ts", "src/[!_]*.ts: Use [^...] to exclude characters, like [^_]."],
      ]) {
        const response = await submitSettings(seeded, { ignorePaths: `*.md\n${pattern}` });

        expect(await response.json()).toMatchObject({ error: { ignorePaths: [message] } });
      }
      const tooMany = Array.from({ length: 5 }, (_, index) => `docs/${index}/**`).join("\n");
      expect(await (await submitSettings(seeded, { ignorePaths: tooMany })).json()).toMatchObject({
        error: { ignorePaths: ["Add at most 4 paths."] },
      });

      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual({
        ignorePaths: ["docs/**"],
      });
    }
  );
});

describe("ignored branches in the Git settings action", () => {
  postgresTest(
    "stores one trimmed branch pattern per line next to the stored paths",
    async ({ prisma }) => {
      // Catches: saving branches dropping the stored paths.
      const seeded = await seed(prisma, { ignorePaths: ["docs/**"] });

      const response = await submitSettings(seeded, {
        ignoreBranches: "  noPreview*  \n\nnoPreview/**\r\ndependabot/**\n",
      });

      expect(response.status).toBe(302);
      const buildFilters = {
        ignorePaths: ["docs/**"],
        ignoreBranches: ["noPreview*", "noPreview/**", "dependabot/**"],
      };
      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual(buildFilters);
      expect((await presented(seeded)).connectedRepository?.buildFilters).toEqual(buildFilters);
    }
  );

  postgresTest(
    "rejects a bad branch pattern with a field error and keeps the stored patterns",
    async ({ prisma }) => {
      // Catches: a branch pattern skipping server-side validation on save.
      const seeded = await seed(prisma, { ignoreBranches: ["dependabot/**"] });

      for (const [pattern, message] of [
        ["!main", "!main: Negated patterns aren't supported. List only the branches to ignore."],
        ["/release", "/release: Branch names never start with a slash."],
        ["feature/", "feature/: Branch names never end with a slash. Use feature/** instead."],
        ["refs/heads/main", "refs/heads/main: Use the branch name without refs/heads/."],
        [
          "@(fix|feat)/**",
          "@(fix|feat)/**: Groups aren't supported. Put each alternative on its own line, or escape ( ) and | with a backslash to match them.",
        ],
      ]) {
        const response = await submitSettings(seeded, { ignoreBranches: `main\n${pattern}` });

        expect(await response.json()).toMatchObject({ error: { ignoreBranches: [message] } });
      }
      const tooMany = Array.from({ length: 5 }, (_, index) => `release-${index}`).join("\n");
      expect(
        await (await submitSettings(seeded, { ignoreBranches: tooMany })).json()
      ).toMatchObject({ error: { ignoreBranches: ["Add at most 4 branches."] } });

      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual({
        ignoreBranches: ["dependabot/**"],
      });
    }
  );
});

describe("both lists in the Git settings action", () => {
  postgresTest(
    "saves both lists from one submission and clears one of them",
    async ({ prisma }) => {
      // Catches: an empty field not clearing its list when the other list changes.
      const seeded = await seed(prisma, { ignorePaths: ["docs/**"], ignoreBranches: ["main"] });

      await submitSettings(seeded, { ignorePaths: "*.md", ignoreBranches: "" });

      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual({
        ignorePaths: ["*.md"],
        ignoreBranches: [],
      });
    }
  );

  postgresTest(
    "keeps the stored paths when the stored branches are malformed",
    async ({ prisma }) => {
      // Catches: one malformed stored list hiding or erasing the other.
      const seeded = await seed(prisma, {
        ignorePaths: ["docs/**"],
        ignoreBranches: "main" as unknown as string[],
      });

      expect((await presented(seeded)).connectedRepository?.buildFilters).toEqual({
        ignorePaths: ["docs/**"],
        ignoreBranches: [],
      });

      await submitSettings(seeded, { ignoreBranches: "dependabot/**" });

      expect((await storedRepo(prisma, seeded.project.id)).buildFilters).toEqual({
        ignorePaths: ["docs/**"],
        ignoreBranches: ["dependabot/**"],
      });
    }
  );

  postgresTest(
    "keeps the stored patterns when an onboarding autosave omits the fields",
    async ({ prisma }) => {
      const seeded = await seed(prisma, {
        ignorePaths: ["docs/**"],
        ignoreBranches: ["dependabot/**"],
      });
      vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        runAction(seeded, new Request(url, init))
      );

      try {
        await saveGitSettings(`http://localhost${seeded.path}`, {
          productionBranch: "main",
          stagingBranch: "",
          previewDeploymentsEnabled: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }

      expect(await storedRepo(prisma, seeded.project.id)).toEqual({
        previewDeploymentsEnabled: false,
        buildFilters: { ignorePaths: ["docs/**"], ignoreBranches: ["dependabot/**"] },
      });
    }
  );
});

describe("GitHub settings presenter", () => {
  postgresTest("reports the Vercel integration and the ignored path limits", async ({ prisma }) => {
    const seeded = await seed(prisma);
    expect(await presented(seeded)).toMatchObject({
      isVercelIntegrationConnected: false,
      connectedRepository: { buildFilters: undefined },
      ignorePatternLimits: { maxPatterns: 4, maxLength: 40 },
    });

    const secret = await prisma.secretReference.create({ data: { key: `vercel_${suffix()}` } });
    const vercel = await prisma.organizationIntegration.create({
      data: {
        friendlyId: `org_integration_${suffix()}`,
        service: "VERCEL",
        organizationId: seeded.organization.id,
        tokenReferenceId: secret.id,
        integrationData: {},
      },
    });
    const projectIntegration = await prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: vercel.id,
        projectId: seeded.project.id,
        externalEntityId: "prj_vercel",
        integrationData: {},
      },
    });
    expect((await presented(seeded)).isVercelIntegrationConnected).toBe(true);

    await prisma.organizationProjectIntegration.update({
      where: { id: projectIntegration.id },
      data: { deletedAt: new Date() },
    });
    expect((await presented(seeded)).isVercelIntegrationConnected).toBe(false);
  });
});
