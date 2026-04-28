import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const MAX_IDS = 100;
const RunIdSchema = z.string().cuid();

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids") ?? "";
  const candidateIds = idsParam
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, MAX_IDS);
  const runIds = candidateIds.filter((id) => RunIdSchema.safeParse(id).success);

  const presenter = new NextRunListPresenter($replica, clickhouseClient);
  const { runs } = await presenter.callByIds(project.organizationId, environment.id, {
    userId,
    runIds,
  });

  return typedjson(
    { runs },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
};
