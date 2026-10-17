import { VercelCore } from "@vercel/sdk/core";
import { environmentGetSharedEnvVar } from "@vercel/sdk/funcs/environmentGetSharedEnvVar";
import { environmentGetV9ProjectsIdOrNameCustomEnvironments } from "@vercel/sdk/funcs/environmentGetV9ProjectsIdOrNameCustomEnvironments";
import { integrationsDeleteConfiguration } from "@vercel/sdk/funcs/integrationsDeleteConfiguration";
import { projectsBatchRemoveProjectEnv } from "@vercel/sdk/funcs/projectsBatchRemoveProjectEnv";
import { projectsCreateProjectEnv } from "@vercel/sdk/funcs/projectsCreateProjectEnv";
import { projectsEditProjectEnv } from "@vercel/sdk/funcs/projectsEditProjectEnv";
import { projectsFilterProjectEnvs } from "@vercel/sdk/funcs/projectsFilterProjectEnvs";
import { projectsGetProjectEnv } from "@vercel/sdk/funcs/projectsGetProjectEnv";
import { projectsGetProjects } from "@vercel/sdk/funcs/projectsGetProjects";
import { projectsUpdateProject } from "@vercel/sdk/funcs/projectsUpdateProject";
import { teamsGetTeam } from "@vercel/sdk/funcs/teamsGetTeam";
import { userGetAuthUser } from "@vercel/sdk/funcs/userGetAuthUser";
import type { RequestOptions } from "@vercel/sdk/lib/sdks";
import type { Result } from "@vercel/sdk/types/fp";

/**
 * A Vercel API client with the same call shape as `new Vercel()` from `@vercel/sdk`,
 * built from the SDK's standalone functions so only the endpoints we call are loaded.
 * The `Vercel` class pulls in every endpoint's schemas, about 250 MB of heap per process.
 * Add a method here when the integration needs a new endpoint.
 */
export function createVercelClient(options: { bearerToken: string }) {
  const core = new VercelCore(options);

  const bind =
    <Request, Response>(
      func: (
        client: VercelCore,
        request: Request,
        options?: RequestOptions
      ) => Promise<Result<Response, unknown>>
    ) =>
    async (request: Request, options?: RequestOptions): Promise<Response> =>
      unwrap(await func(core, request, options));

  return {
    environment: {
      getSharedEnvVar: bind(environmentGetSharedEnvVar),
      getV9ProjectsIdOrNameCustomEnvironments: bind(
        environmentGetV9ProjectsIdOrNameCustomEnvironments
      ),
    },
    integrations: {
      deleteConfiguration: bind(integrationsDeleteConfiguration),
    },
    projects: {
      batchRemoveProjectEnv: bind(projectsBatchRemoveProjectEnv),
      createProjectEnv: bind(projectsCreateProjectEnv),
      editProjectEnv: bind(projectsEditProjectEnv),
      filterProjectEnvs: bind(projectsFilterProjectEnvs),
      getProjectEnv: bind(projectsGetProjectEnv),
      getProjects: bind(projectsGetProjects),
      updateProject: bind(projectsUpdateProject),
    },
    teams: {
      getTeam: bind(teamsGetTeam),
    },
    user: {
      getAuthUser: async (options?: RequestOptions) => unwrap(await userGetAuthUser(core, options)),
    },
  };
}

export type VercelClient = ReturnType<typeof createVercelClient>;

function unwrap<Value>(result: Result<Value, unknown>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
