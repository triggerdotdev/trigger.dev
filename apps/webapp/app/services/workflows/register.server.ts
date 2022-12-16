import { WorkflowMetadataSchema } from "internal-platform";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "~/models/organization.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";

export class RegisterWorkflow {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    slug: string,
    payload: unknown,
    organization: Organization,
    environment: RuntimeEnvironment
  ) {
    const validation = WorkflowMetadataSchema.safeParse(payload);

    if (!validation.success) {
      return {
        status: "validationError" as const,
        errors: validation.error.format(),
      };
    }

    const workflow = await this.#prismaClient.workflow.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug,
        },
      },
      update: {
        title: validation.data.name,
        packageJson: validation.data.package,
      },
      create: {
        organizationId: organization.id,
        slug,
        title: validation.data.name,
        packageJson: validation.data.package,
      },
      include: {
        triggers: {
          where: {
            environmentId: environment.id,
          },
        },
      },
    });

    const existingTrigger = workflow.triggers[0];

    if (!existingTrigger) {
      const trigger = await this.#prismaClient.workflowTrigger.create({
        data: {
          workflowId: workflow.id,
          environmentId: environment.id,
          type: validation.data.trigger.type,
          config: validation.data.trigger.config,
          status: "CREATED",
          isDefault: environment.slug === "development",
        },
      });

      return {
        status: "success" as const,
        data: {
          id: workflow.id,
        },
      };
    } else {
      if (existingTrigger.type === validation.data.trigger.type) {
        await this.#prismaClient.workflowTrigger.update({
          where: {
            id: existingTrigger.id,
          },
          data: {
            config: validation.data.trigger.config,
          },
        });

        return {
          status: "success" as const,
          data: {
            id: workflow.id,
          },
        };
      } else {
        return {
          status: "error" as const,
          error: {
            code: "TRIGGER_TYPE_MISMATCH",
            message: "The trigger type cannot be changed",
          },
        };
      }
    }

    // Create or update the workflow
    //todo triggers are environment specific
    //todo connections are shared between environments
    //todo Workflows have connection slots, which are filled with connections (can be empty)
    //todo Workflow has one trigger (can also have a slot with connection)
    //todo WorkflowRuns belong to a workflow + environment
  }
}
