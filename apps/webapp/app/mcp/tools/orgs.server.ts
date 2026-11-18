import { $replica } from "~/db.server";
import type { McpToolDefinition } from "../registry.server";
import { fenceUntrusted } from "../gate/fence.server";
import { defineReadTool, textResult } from "./define.server";
import { ListOrgsInput, ListProjectsInput } from "./schemas/orgs";

const listOrgs = defineReadTool({
  name: "list_orgs",
  title: "List Organizations",
  description:
    "List all organizations for the current user. Useful when looking up an org slug or ID.",
  shape: ListOrgsInput.shape,
  auth: { user: true, action: "read", subject: "organizations" },
  run: async (_input, { identity }) => {
    const orgs = await $replica.organization.findMany({
      where: {
        deletedAt: null,
        members: { some: { userId: identity.userId } },
      },
    });

    return textResult(
      orgs
        .map(
          (org) =>
            `- ${fenceUntrusted(org.title, "org-title")} (id=${org.id}) (slug=${org.slug}) (createdAt=${org.createdAt.toISOString()})`
        )
        .join("\n")
    );
  },
});

const listProjects = defineReadTool({
  name: "list_projects",
  title: "List Projects",
  description:
    "List all projects for the current user, useful for when searching for a project and for looking up a projectRef",
  shape: ListProjectsInput.shape,
  auth: { user: true, action: "read", subject: "projects" },
  run: async (_input, { identity }) => {
    const projects = await $replica.project.findMany({
      where: {
        organization: {
          deletedAt: null,
          members: { some: { userId: identity.userId } },
        },
        version: "V3",
        deletedAt: null,
      },
      include: { organization: true },
    });

    const groupedByOrg = new Map<
      string,
      { organization: (typeof projects)[number]["organization"]; projects: typeof projects }
    >();
    for (const project of projects) {
      const group = groupedByOrg.get(project.organization.id) ?? {
        organization: project.organization,
        projects: [],
      };
      group.projects.push(project);
      groupedByOrg.set(project.organization.id, group);
    }

    const contents = [...groupedByOrg.values()]
      .map((group) => {
        const parts = [
          `## Organization ${fenceUntrusted(group.organization.title, "org-title")} (id=${group.organization.id}) (slug=${group.organization.slug}) projects:`,
        ];

        for (const project of group.projects) {
          parts.push(
            `- ${fenceUntrusted(project.name, "project-name")} (projectRef=${project.externalRef}) (slug=${project.slug}) (createdAt=${project.createdAt.toISOString()})`
          );
        }

        return parts.join("\n");
      })
      .join("\n");

    return textResult(contents);
  },
});

export const orgsTools: McpToolDefinition[] = [listOrgs, listProjects];
