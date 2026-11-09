import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { describe, expect, vi } from "vitest";
import {
  createEnvironmentApiKey,
  updateEnvironmentApiKeyDescription,
} from "~/models/api-key.server";
import { API_KEY_NOTE_MAX_LENGTH } from "~/utils/apiKeyNote";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function setup(prisma: PrismaClient) {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const create = (description?: string | null) =>
    createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Backend",
        description,
        presetId: "FULL_ACCESS",
        allowedIpRanges: ["203.0.113.9"],
      },
      {
        prismaClient: prisma,
        rbacController: plugin.create(
          { primary: prisma, replica: prisma },
          { forceFallback: true }
        ),
      }
    );
  return { environment, create };
}

describe("API key notes", () => {
  postgresTest("stores a note on create as one trimmed line", async ({ prisma }) => {
    const { create } = await setup(prisma);

    // Catches: a pasted multi-line note stored with its line breaks, breaking the one-line cell.
    const withNote = await create("  Billing service\n  invoices  ");
    expect(withNote.apiKey.description).toBe("Billing service invoices");

    // Catches: a blank note stored as an empty string instead of null.
    const blank = await create("   ");
    expect(blank.apiKey.description).toBeNull();

    // Catches: the server trusting the dialog's maxLength.
    await expect(create("x".repeat(API_KEY_NOTE_MAX_LENGTH + 1))).rejects.toThrow(
      /at most 200 characters/
    );
  });

  postgresTest(
    "edits only the note, on expired keys too, and refuses revoked keys",
    async ({ prisma }) => {
      const { environment, create } = await setup(prisma);
      const { apiKey } = await create("Old note");
      const update = (description: string | null) =>
        updateEnvironmentApiKeyDescription(
          { environmentId: environment.id, apiKeyId: apiKey.id, description },
          { prismaClient: prisma }
        );

      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await expect(update(" New note ")).resolves.toBe("New note");

      const updated = await prisma.apiKey.findFirstOrThrow({ where: { id: apiKey.id } });
      // Catches: the note edit rewriting the key's access, allowed IPs or secret.
      expect(updated).toMatchObject({
        description: "New note",
        name: apiKey.name,
        keyHash: apiKey.keyHash,
        scopes: apiKey.scopes,
        presetId: apiKey.presetId,
        allowedIpRanges: apiKey.allowedIpRanges,
        revokedAt: null,
      });

      await expect(update("")).resolves.toBeNull();
      await expect(
        prisma.apiKey.findFirstOrThrow({ where: { id: apiKey.id } })
      ).resolves.toMatchObject({ description: null });

      await expect(update("x".repeat(API_KEY_NOTE_MAX_LENGTH + 1))).rejects.toThrow(
        /at most 200 characters/
      );

      // Catches: a key from another environment edited through this one.
      await expect(
        updateEnvironmentApiKeyDescription(
          { environmentId: "other-environment", apiKeyId: apiKey.id, description: "Hijack" },
          { prismaClient: prisma }
        )
      ).rejects.toThrow(/not found or already revoked/);

      // Catches: a revoked key's note still editable after it stopped working.
      await prisma.apiKey.update({ where: { id: apiKey.id }, data: { revokedAt: new Date() } });
      await expect(update("After revoke")).rejects.toThrow(/not found or already revoked/);
    }
  );
});
