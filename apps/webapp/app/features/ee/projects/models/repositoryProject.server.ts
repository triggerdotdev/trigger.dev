import type {
  RepositoryProject,
  RuntimeEnvironment,
  ProjectDeployment,
} from ".prisma/client";
import { z } from "zod";
import { parse as parseYAML } from "yaml";
import { getRepositoryContent } from "~/features/ee/projects/github/githubApp.server";
import { refreshInstallationAccessToken } from "~/features/ee/projects/github/refreshInstallationAccessToken.server";
import { env } from "~/env.server";
import { prisma } from "~/db.server";

export async function findProjectByRepo(name: string) {
  return await prisma.repositoryProject.findUnique({
    where: {
      name,
    },
    include: {
      organization: {
        include: {
          environments: true,
        },
      },
    },
  });
}

export async function findProjectById(id: string) {
  return await prisma.repositoryProject.findUnique({
    where: {
      id,
    },
    include: {
      organization: {
        include: {
          environments: true,
        },
      },
    },
  });
}

// Generates a new version number for a deployment
// The version numbers are in the following format:
// YYYYMMDD.NUMBER
//
// So for example, the first deploy on March 7th, 2023 would be:
// 20230307.1
// The second deploy on March 7th, 2023 would be:
// 20230307.2
//
// The version number is used to determine the order of deployments
export async function getNextDeploymentVersion(
  projectId: string
): Promise<string> {
  const latestDeploymentVersion = await getLatestDeploymentVersion(projectId);

  const generateCurrentDatePart = () => {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  };

  if (!latestDeploymentVersion) {
    return `${generateCurrentDatePart()}.1`;
  }

  const [datePart, numberPart] = latestDeploymentVersion.split(".");

  if (datePart === generateCurrentDatePart()) {
    return `${datePart}.${Number(numberPart) + 1}`;
  }

  return `${generateCurrentDatePart()}.1`;
}

async function getLatestDeploymentVersion(
  projectId: string
): Promise<string | undefined> {
  const latestDeployment = await prisma.projectDeployment.findFirst({
    where: {
      projectId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      version: true,
    },
  });

  if (!latestDeployment) {
    return;
  }

  return latestDeployment.version;
}

export function statusTextForBuilding(
  deployment: ProjectDeployment,
  project: RepositoryProject
) {
  return `Building ${project.name}#${project.branch} at ${truncateSha(
    deployment.commitHash
  )}: "${deployment.commitMessage}" by ${deployment.committer}`;
}

export function statusTextForDeploying(
  deployment: ProjectDeployment,
  project: RepositoryProject
) {
  return `Deploying ${project.name}#${project.branch} at ${truncateSha(
    deployment.commitHash
  )}: "${deployment.commitMessage}" by ${deployment.committer}`;
}

export function statusTextForDeployed(
  deployment: ProjectDeployment,
  project: RepositoryProject
) {
  return `Deployed ${project.name}#${project.branch} at ${truncateSha(
    deployment.commitHash
  )}: "${deployment.commitMessage}" by ${deployment.committer}`;
}

function truncateSha(sha: string) {
  return sha.substring(0, 7);
}

export function repositoryProjectReadyToDeploy(project: RepositoryProject) {
  return project.status === "PENDING" && hasAllEnvVars(project);
}

export function buildEnvVars(
  deployment: ProjectDeployment,
  project: RepositoryProject,
  environment: RuntimeEnvironment
): Record<string, string> {
  const envVars = BluePrintEnvVarsSchema.parse(project.envVars);

  const result = envVars.reduce((acc, envVar) => {
    if (envVar.key === "TRIGGER_API_KEY") {
      return {
        ...acc,
        [envVar.key]: environment.apiKey,
      };
    }

    if (!envVar.value) {
      return acc;
    }

    return {
      ...acc,
      [envVar.key]: envVar.value,
    };
  }, {});

  return {
    ...result,
    TRIGGER_PROJECT_ID: project.id,
    TRIGGER_DEPLOYMENT_ID: deployment.id,
    TRIGGER_WSS_URL: env.TRIGGER_WSS_URL,
  };
}

export function hasAllEnvVars(project: RepositoryProject) {
  const envVars = BluePrintEnvVarsSchema.parse(project.envVars);

  // Removing the TRIGGER_API_KEY environment var, are there any other env vars that don't have a value?
  return (
    envVars
      .filter((envVar) => envVar.key !== "TRIGGER_API_KEY")
      .filter((envVar) => !envVar.value).length === 0
  );
}

export function parseEnvVars(project: RepositoryProject) {
  return BluePrintEnvVarsSchema.parse(project.envVars).filter(
    (envVar) => envVar.key !== "TRIGGER_API_KEY"
  );
}

export async function serviceDefinitionFromRepository(
  appAuthorizationId: string,
  repoName: string
) {
  const appAuthorization = await refreshInstallationAccessToken(
    appAuthorizationId
  );

  const renderYamlContent = await getRepositoryContent(
    appAuthorization.installationAccessToken,
    repoName,
    "render.yaml"
  );

  if (!renderYamlContent) {
    return;
  }

  const rawRenderYaml = safeParseYAML(renderYamlContent);

  if (!rawRenderYaml) {
    return;
  }

  const blueprint = BlueprintSchema.safeParse(rawRenderYaml);

  if (!blueprint.success) {
    return;
  }

  // Find a worker service with env = node and an envVar with the name TRIGGER_API_KEY
  const workerService = blueprint.data.services.find(
    (service) =>
      service.type === "worker" &&
      service.env === "node" &&
      service.envVars.find((envVar) => envVar.key === "TRIGGER_API_KEY")
  );

  return workerService;
}

function safeParseYAML(content: string) {
  try {
    return parseYAML(content);
  } catch (error) {
    return;
  }
}

const BluePrintEnvVarsSchema = z.array(
  z
    .object({
      key: z.string(),
      value: z.any(),
      sync: z.boolean().default(true),
    })
    .passthrough()
);

const BlueprintServiceSchema = z
  .object({
    name: z.string(),
    type: z.enum(["web", "worker", "pserv", "cron"]),
    env: z.enum([
      "node",
      "go",
      "python",
      "ruby",
      "php",
      "java",
      "docker",
      "rust",
      "static",
    ]),
    buildCommand: z.string().optional(),
    startCommand: z.string().optional(),
    autoDeploy: z.boolean().default(true),
    envVars: BluePrintEnvVarsSchema,
  })
  .passthrough();

export type BlueprintService = z.infer<typeof BlueprintServiceSchema>;

const BlueprintSchema = z.object({
  services: z.array(BlueprintServiceSchema),
});
