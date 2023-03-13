import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { BlueprintService } from "~/features/ee/projects/models/repositoryProject.server";
import {
  repositoryProjectReadyToDeploy,
  serviceDefinitionFromRepository,
} from "~/features/ee/projects/models/repositoryProject.server";
import { taskQueue } from "~/services/messageBroker.server";

const FormSchema = z.object({
  repoId: z.string(),
  repoName: z.string(),
  appAuthorizationId: z.string(),
});

export type CreateProjectValidationResult =
  | {
      type: "payloadError";
      errors: z.ZodIssue[];
    }
  | {
      type: "serviceDefinitionError";
      message: string;
    }
  | {
      type: "success";
      data: z.infer<typeof FormSchema>;
      serviceDefinition: BlueprintService;
    };

export class CreateProjectService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    userId: string,
    organizationSlug: string,
    data: z.infer<typeof FormSchema>,
    serviceDefinition: BlueprintService
  ) {
    try {
      const project = await this.#prismaClient.repositoryProject.create({
        data: {
          name: data.repoName,
          url: `https://github.com/${data.repoName}`,
          authorization: {
            connect: {
              id: data.appAuthorizationId,
            },
          },
          branch: "main",
          organization: {
            connect: {
              slug: organizationSlug,
            },
          },
          buildCommand: serviceDefinition.buildCommand ?? "npm run build",
          startCommand: serviceDefinition.startCommand ?? "npm run start",
          envVars: serviceDefinition.envVars,
        },
      });

      if (repositoryProjectReadyToDeploy(project)) {
        await this.#prismaClient.repositoryProject.update({
          where: {
            id: project.id,
          },
          data: {
            status: "PREPARING",
          },
        });

        await taskQueue.publish("START_INITIAL_PROJECT_DEPLOYMENT", {
          id: project.id,
        });
      }

      return { type: "success" as const, project };
    } catch (error) {
      // Handle Prisma unique constraint error (name must be unique)

      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return {
          type: "serviceError" as const,
          message:
            "Cannot deploy this repository because it is already being used.",
        };
      }

      throw error;
    }
  }

  public async validate(
    payload: unknown
  ): Promise<CreateProjectValidationResult> {
    const payloadValidation = FormSchema.safeParse(payload);

    if (!payloadValidation.success) {
      return {
        type: "payloadError" as const,
        errors: payloadValidation.error.issues,
      };
    }

    const serviceDefinition = await serviceDefinitionFromRepository(
      payloadValidation.data.appAuthorizationId,
      payloadValidation.data.repoName
    );

    const serviceDefinitionErrorMessage = `Could not deploy ${payloadValidation.data.repoName} because deploying this type of repository is not supported. We currently only support deploying repositories based on Trigger.dev templates`;

    if (!serviceDefinition) {
      return {
        type: "serviceDefinitionError" as const,
        message: serviceDefinitionErrorMessage,
      };
    }

    if (!this.#validateServiceMetadata(serviceDefinition)) {
      return {
        type: "serviceDefinitionError" as const,
        message: serviceDefinitionErrorMessage,
      };
    }

    return {
      type: "success" as const,
      data: payloadValidation.data,
      serviceDefinition,
    };
  }

  // Make sure the service metadata is valid
  // env = node
  // type = worker
  // envVar with key TRIGGER_API_KEY
  #validateServiceMetadata(serviceMetadata: BlueprintService) {
    return (
      serviceMetadata.env === "node" &&
      serviceMetadata.type === "worker" &&
      serviceMetadata.envVars.find((envVar) => envVar.key === "TRIGGER_API_KEY")
    );
  }
}
