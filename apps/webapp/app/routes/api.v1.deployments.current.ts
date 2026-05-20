import { json } from "@remix-run/server-runtime";
import { $replica } from "~/db.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    allowJWT: true,
    corsStrategy: "none",
    authorization: {
      action: "read",
      resource: () => ({ type: "deployments", id: "current" }),
    },
    findResource: async (_params, auth) => {
      const promotion = await $replica.workerDeploymentPromotion.findFirst({
        where: {
          environmentId: auth.environment.id,
          label: "current",
        },
        select: {
          deployment: {
            select: {
              friendlyId: true,
              createdAt: true,
              shortCode: true,
              version: true,
              runtime: true,
              runtimeVersion: true,
              status: true,
              deployedAt: true,
              git: true,
              errorData: true,
            },
          },
        },
      });

      return promotion?.deployment ?? undefined;
    },
  },
  async ({ resource: deployment }) => {
    return json({
      id: deployment.friendlyId,
      createdAt: deployment.createdAt,
      shortCode: deployment.shortCode,
      version: deployment.version,
      runtime: deployment.runtime,
      runtimeVersion: deployment.runtimeVersion,
      status: deployment.status,
      deployedAt: deployment.deployedAt ?? undefined,
      git: deployment.git ?? undefined,
      error: deployment.errorData ?? undefined,
    });
  }
);
