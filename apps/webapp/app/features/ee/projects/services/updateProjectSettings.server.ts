import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import {
  parseEnvVars,
  repositoryProjectReadyToDeploy,
} from "~/features/ee/projects/models/repositoryProject.server";

const ValueSchema = z
  .string()
  .min(1, { message: "Environment variables cannot be blank" })
  .max(1024, {
    message: "Environment variables cannot be longer than 1024 characters",
  })
  .trim();

const EnvVarSchema = z.record(ValueSchema);

const PayloadSchema = z.object({
  buildCommand: z
    .string()
    .min(1, { message: "Build Command cannot be blank" })
    .max(1024)
    .trim(),
  startCommand: z
    .string()
    .min(1, { message: "Start Command cannot be blank" })
    .max(1024),
  branch: z.string().min(1, { message: "Branch cannot be blank" }).max(256),
  autoDeploy: z.enum(["yes", "no"]),
});

const FormSchema = PayloadSchema.extend({
  envVars: EnvVarSchema,
});

export type UpdateEnvironmentVariablesValidationResult =
  | {
      type: "payloadError";
      errors: z.ZodIssue[];
    }
  | {
      type: "success";
      data: z.infer<typeof FormSchema>;
    };

export class UpdateProjectSettings {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(projectId: string, data: z.infer<typeof FormSchema>) {
    const project =
      await this.#prismaClient.repositoryProject.findUniqueOrThrow({
        where: {
          id: projectId,
        },
      });

    const envVars = parseEnvVars(project);

    const newEnvVars = envVars.map((envVar) => {
      if (data.envVars[envVar.key]) {
        return {
          ...envVar,
          value: data.envVars[envVar.key],
        };
      }

      return envVar;
    });

    const udpatedProject = await this.#prismaClient.repositoryProject.update({
      where: {
        id: projectId,
      },
      data: {
        envVars: [...newEnvVars, { key: "TRIGGER_API_KEY", sync: false }],
        buildCommand: data.buildCommand,
        startCommand: data.startCommand,
        autoDeploy: data.autoDeploy === "yes",
        branch: data.branch,
      },
    });

    let shouldDeploy = false;

    if (repositoryProjectReadyToDeploy(udpatedProject)) {
      await this.#prismaClient.repositoryProject.update({
        where: {
          id: projectId,
        },
        data: {
          status: "PREPARING",
        },
      });

      // await taskQueue.publish("START_INITIAL_PROJECT_DEPLOYMENT", {
      //   id: projectId,
      // });

      shouldDeploy = true;
    }

    return shouldDeploy;
  }

  public validate(
    payload: unknown,
    envVars: Record<string, string>
  ): UpdateEnvironmentVariablesValidationResult {
    const envVarsValidation = EnvVarSchema.safeParse(envVars);

    if (!envVarsValidation.success) {
      return {
        type: "payloadError" as const,
        errors: envVarsValidation.error.issues,
      };
    }

    const payloadValidation = PayloadSchema.safeParse(payload);

    if (!payloadValidation.success) {
      return {
        type: "payloadError" as const,
        errors: payloadValidation.error.issues,
      };
    }

    return {
      type: "success" as const,
      data: { ...payloadValidation.data, envVars: envVarsValidation.data },
    };
  }
}
