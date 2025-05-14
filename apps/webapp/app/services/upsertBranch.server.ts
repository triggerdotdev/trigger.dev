import { type PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { upsertBranchEnvironment } from "~/models/organization.server";
import { type CreateBranchOptions } from "~/routes/resources.branches.new";
import { logger } from "./logger.server";
import { getLimit } from "./platform.v3.server";
import { z } from "zod";

/*
Regex that only allows 
- alpha (upper, lower)
- dashes
- underscores
- period
- slashes
- At least one character
*/
const branchRegEx = /[a-zA-Z\-_.]+/;

// name schema, use on the frontend too to give errors in the browser
const BranchName = z.preprocess((val) => {
  return val;
}, z.string());

//TODO CreateBranchService
//- Should "upsert" branch

//TODO At the database layer prevent duplicate projectId, slug
//look at /// The second one implemented in SQL only prevents a TaskRun + Waitpoint with a null batchIndex
// @@unique([taskRunId, waitpointId, batchIndex])

//TODO Archive
// - Save the slug in another column
// - Scramble the slug column (archivedSlug)

//TODO unarchiving
// - Only unarchive if there isn't an active branch with the same name
// - Restore the slug from the other column

//TODO
// When finding an environment for the URL ($envParam) only find non-archived ones

export class UpsertBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(userId: string, { parentEnvironmentId, branchName }: CreateBranchOptions) {
    try {
      const parentEnvironment = await this.#prismaClient.runtimeEnvironment.findFirstOrThrow({
        where: {
          id: parentEnvironmentId,
          organization: {
            members: {
              some: {
                userId: userId,
              },
            },
          },
        },
        include: {
          organization: {
            select: {
              id: true,
              slug: true,
              maximumConcurrencyLimit: true,
            },
          },
          project: {
            select: {
              id: true,
              slug: true,
            },
          },
        },
      });

      if (!parentEnvironment.isBranchableEnvironment) {
        return {
          success: false as const,
          error: "Parent environment is not branchable",
        };
      }

      const limits = await checkBranchLimit(
        this.#prismaClient,
        parentEnvironment.organization.id,
        parentEnvironment.project.id
      );

      if (limits.isAtLimit) {
        return {
          success: false as const,
          error: `You've used all ${limits.used} of ${limits.limit} branches for your plan. Upgrade to get more branches or archive some.`,
        };
      }

      const branch = await upsertBranchEnvironment({
        organization: parentEnvironment.organization,
        project: parentEnvironment.project,
        parentEnvironment,
        branchName,
      });

      return {
        success: true as const,
        alreadyExisted: branch.alreadyExisted,
        branch: branch.branch,
        organization: parentEnvironment.organization,
        project: parentEnvironment.project,
      };
    } catch (e) {
      logger.error("CreateBranchService error", { error: e });
      return {
        success: false as const,
        error: "Failed to create branch",
      };
    }
  }
}

export async function checkBranchLimit(
  prisma: PrismaClientOrTransaction,
  organizationId: string,
  projectId: string
) {
  const used = await prisma.runtimeEnvironment.count({
    where: {
      projectId,
      branchName: {
        not: null,
      },
      archivedAt: null,
    },
  });
  const limit = await getLimit(organizationId, "branches", 50);

  return {
    used,
    limit,
    isAtLimit: used >= limit,
  };
}
