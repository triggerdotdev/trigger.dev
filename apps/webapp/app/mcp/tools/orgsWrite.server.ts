import { CreateProjectRequestBody } from "@trigger.dev/core/v3";
import cuid from "cuid";
import { prisma } from "~/db.server";
import { createProject } from "~/models/project.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolDefinition } from "../registry.server";
import { textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import { CreateProjectInOrgInput } from "./schemas/write";

const { isCuid } = cuid;

export const orgsWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "create_project_in_org",
    title: "Create Project in Organization",
    description:
      "Create a new project in an organization. Only do this if the user wants to add Trigger.dev to an existing project. If there is already a trigger.config.ts file present, then you should not create a new project.",
    shape: CreateProjectInOrgInput.shape,
    approval: "configurable",
    auth: { user: true, action: "write", subject: "projects" },
    run: async (input, { identity }) => {
      const organization = await prisma.organization.findFirst({
        where: {
          ...(isCuid(input.orgParam) ? { id: input.orgParam } : { slug: input.orgParam }),
          deletedAt: null,
          members: { some: { userId: identity.userId } },
        },
        select: { slug: true },
      });
      if (!organization) return fencedError("Organization not found", "create-project-error");

      const body = CreateProjectRequestBody.safeParse({ name: input.name });
      if (!body.success) return fencedError(body.error.message, "create-project-error");

      try {
        const project = await createProject({
          organizationSlug: organization.slug,
          name: body.data.name,
          userId: identity.userId,
          version: "v3",
        });

        return textResult(
          `Project created successfully: ${project.name} (projectRef=${project.externalRef}) (slug=${project.slug}) (createdAt=${project.createdAt.toISOString()})`
        );
      } catch (error) {
        if (error instanceof ServiceValidationError) {
          return fencedError(error.message, "create-project-error");
        }
        return fencedError("Failed to create project", "create-project-error");
      }
    },
  }),
];
