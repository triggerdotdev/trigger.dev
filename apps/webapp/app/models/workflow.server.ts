import type {
  Organization,
  User,
  Workflow,
  ExternalSource,
} from ".prisma/client";
import { z } from "zod";
import { prisma } from "~/db.server";
export type { Workflow } from ".prisma/client";

export type { ExternalSource, EventRule } from ".prisma/client";

export const WorkflowMetadataSchema = z.object({
  git: z
    .object({
      sha: z.string().optional().nullable(),
      branch: z.string().optional().nullable(),
      origin: z.string().optional().nullable(),
      committer: z.string().optional().nullable(),
      commitMessage: z.string().optional().nullable(),
      committerDate: z.string().optional().nullable(),
    })
    .optional(),
  packageMetadata: z
    .object({
      template: z.string().optional().nullable(),
    })
    .optional(),
});

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;

export function getRepositoryFromMetadata(metadata: unknown) {
  const parsedMetadata = parseMetadata(metadata);

  if (parsedMetadata.git && parsedMetadata.git.origin) {
    return translateOriginToGitHubRepo(parsedMetadata.git.origin);
  }
}

// Turns a git origin into a GitHub repo slug
// Could be in the following formats:
// https://github.com/triggerdotdev/trigger.dev.git
// git@github.com:triggerdotdev/trigger.dev.git
//
// And it should produce the following output:
// triggerdotdev/trigger.dev
//
// Use regex because git@github.com:triggerdotdev/trigger.dev.git isn't a valid url
function translateOriginToGitHubRepo(origin: string) {
  const match = origin.match(/github\.com[:/]([^/]+\/[^/]+)\.git/);

  if (match) {
    return match[1];
  }

  return;
}

function parseMetadata(metadata: unknown) {
  try {
    return WorkflowMetadataSchema.parse(metadata);
  } catch (e) {
    return {};
  }
}

export type WorkflowWithExternalSource = Workflow & {
  externalSource: ExternalSource;
};

export function getWorkflowFromSlugs({
  userId,
  organizationSlug,
  workflowSlug,
}: {
  userId: User["id"];
  organizationSlug: Organization["slug"];
  workflowSlug: Workflow["slug"];
}) {
  return prisma.workflow.findFirst({
    include: {
      externalSource: {
        select: {
          id: true,
          type: true,
          source: true,
          status: true,
          connection: true,
          key: true,
          service: true,
          manualRegistration: true,
          secret: true,
        },
      },
      externalServices: {
        select: {
          id: true,
          type: true,
          status: true,
          connection: true,
          slug: true,
          service: true,
        },
      },
      rules: {
        select: {
          id: true,
          type: true,
          trigger: true,
          environmentId: true,
          enabled: true,
        },
      },
      organizationTemplate: {
        select: {
          repositoryUrl: true,
        },
      },
    },
    where: {
      slug: workflowSlug,
      organization: {
        slug: organizationSlug,
        users: {
          some: {
            id: userId,
          },
        },
      },
    },
  });
}
