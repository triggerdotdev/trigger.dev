import { createHash } from "crypto";
import { prisma } from "~/db.server";
import { BaseService, ServiceValidationError } from "./baseService.server";

export class PromptService extends BaseService {
  async promoteVersion(promptId: string, versionId: string, options?: { sourceGuard?: boolean }) {
    const target = await this._prisma.promptVersion.findUnique({
      where: { id: versionId },
    });

    if (!target) {
      throw new ServiceValidationError("Version not found", 404);
    }

    if (target.promptId !== promptId) {
      throw new ServiceValidationError("Version does not belong to this prompt", 400);
    }

    if (options?.sourceGuard && target.source !== "code") {
      throw new ServiceValidationError(
        "Only code-sourced versions can be promoted. Use the override API instead.",
        400
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "prompt_versions"
        SET "labels" = array_remove("labels", 'current')
        WHERE "promptId" = ${promptId} AND 'current' = ANY("labels")
      `;
      await tx.$executeRaw`
        UPDATE "prompt_versions"
        SET "labels" = array_append("labels", 'current')
        WHERE "id" = ${versionId} AND NOT ('current' = ANY("labels"))
      `;
    });
  }

  async createOverride(
    promptId: string,
    data: {
      textContent: string;
      model?: string;
      commitMessage?: string;
      source?: string;
      createdBy?: string;
    }
  ) {
    const contentHash = createHash("sha256").update(data.textContent).digest("hex").slice(0, 16);
    const nextVersion = await this.#getNextVersionNumber(promptId);

    // Remove any existing override, then create new — wraps in transaction
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "prompt_versions"
        SET "labels" = array_remove("labels", 'override')
        WHERE "promptId" = ${promptId} AND 'override' = ANY("labels")
      `;

      await tx.promptVersion.create({
        data: {
          promptId,
          version: nextVersion,
          textContent: data.textContent,
          model: data.model || null,
          source: data.source || "dashboard",
          commitMessage: data.commitMessage || null,
          contentHash,
          labels: ["override"],
          createdBy: data.createdBy,
        },
      });
    });

    return { version: nextVersion };
  }

  async updateOverride(
    promptId: string,
    data: {
      textContent?: string;
      model?: string;
      commitMessage?: string;
    }
  ) {
    const overrideVer = await this._prisma.promptVersion.findFirst({
      where: { promptId, labels: { has: "override" } },
      orderBy: { version: "desc" },
    });

    if (!overrideVer) {
      throw new ServiceValidationError("No active override to update", 400);
    }

    const contentString = data.textContent ?? overrideVer.textContent ?? "";
    const contentHash = createHash("sha256").update(contentString).digest("hex").slice(0, 16);

    await this._prisma.promptVersion.update({
      where: { id: overrideVer.id },
      data: {
        textContent: contentString,
        model: data.model || overrideVer.model,
        commitMessage: data.commitMessage || overrideVer.commitMessage,
        contentHash,
      },
    });
  }

  async removeOverride(promptId: string) {
    await this.#removeLabel(promptId, "override");
  }

  async reactivateOverride(promptId: string, versionId: string) {
    const target = await this._prisma.promptVersion.findUnique({
      where: { id: versionId },
    });

    if (!target) {
      throw new ServiceValidationError("Version not found", 404);
    }

    if (target.source === "code") {
      throw new ServiceValidationError(
        "Code-sourced versions cannot be reactivated as overrides",
        400
      );
    }

    await this.#removeLabel(promptId, "override");
    await this.#addLabel(versionId, "override");
  }

  async #removeLabel(promptId: string, label: string) {
    await this._prisma.$executeRaw`
      UPDATE "prompt_versions"
      SET "labels" = array_remove("labels", ${label})
      WHERE "promptId" = ${promptId} AND ${label} = ANY("labels")
    `;
  }

  async #addLabel(versionId: string, label: string) {
    await this._prisma.$executeRaw`
      UPDATE "prompt_versions"
      SET "labels" = array_append("labels", ${label})
      WHERE "id" = ${versionId} AND NOT (${label} = ANY("labels"))
    `;
  }

  async #getNextVersionNumber(promptId: string): Promise<number> {
    const latest = await this._prisma.promptVersion.findFirst({
      where: { promptId },
      orderBy: { version: "desc" },
    });
    return (latest?.version ?? 0) + 1;
  }
}
