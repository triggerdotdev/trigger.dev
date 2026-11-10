import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import type { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import type { DeploymentAccessController, DeploymentAccessDecision } from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { CardVerificationGate } from "~/v3/cardVerificationGate.server";
import { cardVerificationDeployRefusal } from "~/v3/cardVerificationDeployGate.server";
import { DeploymentAccessError } from "~/v3/deploymentAccess.server";
import { InitializeDeploymentService } from "~/v3/services/initializeDeployment.server";

vi.setConfig({ testTimeout: 60_000 });

const refusalFor = (gate: CardVerificationGate, log = { error: vi.fn() }) =>
  cardVerificationDeployRefusal(
    { id: "org_1", slug: "acme", title: "Acme" },
    { resolveGate: async () => gate, appOrigin: "https://cloud.example.com", log }
  );

describe("cardVerificationDeployRefusal", () => {
  // Catches: a gated org refused without the card step link, so the user can't unblock the deploy.
  it("refuses a gated org with a link to the card step", async () => {
    expect(await refusalFor("gated")).toBe(
      [
        "Unlock your Free tier credits to deploy.",
        "\u201cAcme\u201d needs a card on file to use its free credits for deployments. It\u2019s a verification check only, so you won\u2019t be charged.",
        "Add a card: https://cloud.example.com/orgs/acme/select-plan/card",
      ].join("\n")
    );
  });

  // Catches: a billing outage blocking every paid and enterprise deploy in the cohort, or the
  // fail-open path going unlogged.
  it("fails open with an error log when billing can't be read", async () => {
    const log = { error: vi.fn() };
    expect(await refusalFor("unknown", log)).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      "Card verification gate unknown, letting the deploy through",
      { organizationId: "org_1" }
    );
  });
});

async function environmentFor(prisma: PrismaClient): Promise<AuthenticatedEnvironment> {
  const id = randomUUID();
  const organization = await prisma.organization.create({
    data: { title: "Org", slug: `org-${id}` },
  });
  const project = await prisma.project.create({
    data: {
      name: "Project",
      slug: id,
      externalRef: `proj_${id}`,
      organizationId: organization.id,
      engine: "V2",
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: id,
      pkApiKey: id,
      shortcode: id,
      projectId: project.id,
      organizationId: organization.id,
    },
  });
  return { ...environment, organization, project } as unknown as AuthenticatedEnvironment;
}

// A bundle build with more env vars than allowed: the first check after the card gate, so an
// error naming it proves the deploy got past the gate without building anything.
const payload = (triggeredVia: string) =>
  ({
    type: "MANAGED",
    contentHash: "hash",
    triggeredVia,
    isNativeBuild: true,
    fromBundle: true,
    buildEnvVars: Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`K${i}`, "v"])),
  }) as unknown as InitializeDeploymentRequestBody;

function accessController(decision: DeploymentAccessDecision): DeploymentAccessController {
  return {
    async checkDeploy() {
      return decision;
    },
    async integrationAccess() {
      return { github: true, vercel: true };
    },
  };
}

async function initialize(
  prisma: PrismaClient,
  {
    triggeredVia = "cli",
    refusal,
    access = { allowed: true },
  }: { triggeredVia?: string; refusal: string | undefined; access?: DeploymentAccessDecision }
) {
  const environment = await environmentFor(prisma);
  const cardRefusal = vi.fn(async () => refusal);
  const service = new InitializeDeploymentService(
    prisma,
    prisma,
    accessController(access),
    cardRefusal
  );
  const error: unknown = await service.call(environment, payload(triggeredVia)).then(
    () => undefined,
    (thrown) => thrown
  );
  const deployments = await prisma.workerDeployment.count({
    where: { environmentId: environment.id },
  });
  return { error, deployments, cardRefusal };
}

const card = "Unlock your Free tier credits to deploy.";

// Catches: a gated org's CLI or GitHub deploy creating a deployment, or being refused without
// the card message the CLI prints and the GitHub check shows.
postgresTest(
  "a gated org's CLI and GitHub deploys are refused with the card message",
  async ({ prisma }) => {
    for (const triggeredVia of ["cli", "git_integration:github"]) {
      const { error, deployments } = await initialize(prisma, { triggeredVia, refusal: card });
      expect(error).toBeInstanceOf(DeploymentAccessError);
      expect(error).toMatchObject({ message: card, status: 403 });
      expect(deployments).toBe(0);
    }
  }
);

// Catches: the card check refusing an org it let through (not gated, or billing unreadable).
postgresTest("an org the card check lets through goes past the gate", async ({ prisma }) => {
  const { error } = await initialize(prisma, { refusal: undefined });
  expect((error as Error).message).toMatch(/Build environment variable count \(401\) exceeds/);
});

// Catches: the card check replacing or reordering the deployment access plugin's checks.
postgresTest(
  "the deployment access plugin's denial and limit still win over the card check",
  async ({ prisma }) => {
    for (const access of [
      { allowed: false, kind: "denied", message: "blocked" },
      { allowed: false, kind: "limited", message: "limited" },
    ] as const) {
      const { error, cardRefusal } = await initialize(prisma, { refusal: card, access });
      expect((error as Error).message).toBe(access.message);
      expect(cardRefusal).not.toHaveBeenCalled();
    }
  }
);
