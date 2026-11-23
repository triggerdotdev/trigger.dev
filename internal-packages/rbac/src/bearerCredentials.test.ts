// The host's bearer credential resolver against real Postgres. Additional keys are resolved here
// whether or not the RBAC plugin is installed: the controller routes them to this resolver either
// way, so what it returns is what audit attribution sees.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect } from "vitest";
import { BearerCredentialResolver } from "./bearerCredentials.js";

function uniqueSuffix() {
  return randomBytes(6).toString("hex");
}

/** An additional key in the `tr_prod_sk_` format: 24 letters and digits after the prefix. */
function additionalApiKey() {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const body = Array.from(randomBytes(24), (byte) => alphabet[byte % alphabet.length]).join("");
  return `tr_prod_sk_${body}`;
}

function bearerRequest(token: string) {
  return new Request("https://api.trigger.dev/api/v1/projects/proj/envvars/prod", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function createProductionEnvironment(prisma: PrismaClient) {
  const suffix = uniqueSuffix();
  const organization = await prisma.organization.create({
    data: { slug: `org-${suffix}`, title: "Org" },
  });
  const project = await prisma.project.create({
    data: {
      slug: `proj-${suffix}`,
      name: "Project",
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  return prisma.runtimeEnvironment.create({
    data: {
      slug: `prod-${suffix}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_root${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `sc-${suffix}`,
    },
  });
}

async function createAdditionalKey(
  prisma: PrismaClient,
  environmentId: string,
  issuedBy: "USER" | "SYSTEM"
) {
  const key = additionalApiKey();
  await prisma.apiKey.create({
    data: {
      name: issuedBy === "SYSTEM" ? "Deploy key" : "Integration",
      keyHash: createHash("sha256").update(key).digest("hex"),
      lastFour: key.slice(-4),
      runtimeEnvironmentId: environmentId,
      scopes: ["write:deployments"],
      issuedBy,
    },
  });
  return key;
}

describe("BearerCredentialResolver additional keys", () => {
  // Catches: who issued an additional key being dropped, so a build's platform-minted deploy key
  // is audited as the customer's own key, or a customer's key as Trigger.dev infrastructure.
  postgresTest("returns who issued the key with its resolution", async ({ prisma }) => {
    const environment = await createProductionEnvironment(prisma);
    const deployKey = await createAdditionalKey(prisma, environment.id, "SYSTEM");
    const customerKey = await createAdditionalKey(prisma, environment.id, "USER");
    const resolver = new BearerCredentialResolver({ primary: prisma, replica: prisma });

    const deploy = await resolver.authenticate(bearerRequest(deployKey));
    const customer = await resolver.authenticate(bearerRequest(customerKey));

    expect(deploy).toMatchObject({
      ok: true,
      resolution: {
        credentialKind: "additional_api_key",
        lookupPath: "additional",
        apiKeyIssuedBy: "SYSTEM",
      },
    });
    expect(customer).toMatchObject({
      ok: true,
      resolution: { credentialKind: "additional_api_key", apiKeyIssuedBy: "USER" },
    });
  });
});
