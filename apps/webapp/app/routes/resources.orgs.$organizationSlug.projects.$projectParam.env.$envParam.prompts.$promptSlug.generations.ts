import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { parsePeriodToMs } from "~/utils/periods";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import {
  PromptPresenter,
  type GenerationRow,
  type GenerationsPagination,
} from "~/presenters/v3/PromptPresenter.server";

export type { GenerationRow, GenerationsPagination };

export type GenerationsResponse = {
  generations: GenerationRow[];
  pagination: GenerationsPagination;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, promptSlug } =
    EnvironmentParamSchema.extend({ promptSlug: z.string() }).parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const url = new URL(request.url);

  const versions = url.searchParams
    .getAll("versions")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  const period = url.searchParams.get("period") ?? "7d";
  if (!/^\d+[mhdw]$/.test(period)) {
    return json({ generations: [], pagination: {} } satisfies GenerationsResponse);
  }

  const fromTime = url.searchParams.get("from");
  const toTime = url.searchParams.get("to");
  const cursorParam = url.searchParams.get("cursor") ?? undefined;

  const periodMs = parsePeriodToMs(period);
  const startTime = fromTime ? new Date(fromTime) : new Date(Date.now() - periodMs);
  const endTime = toTime ? new Date(toTime) : new Date();

  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
    return json({ generations: [], pagination: {} } satisfies GenerationsResponse);
  }

  const models = url.searchParams.getAll("models").filter(Boolean);
  const operations = url.searchParams.getAll("operations").filter(Boolean);
  const providers = url.searchParams.getAll("providers").filter(Boolean);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard");
  const presenter = new PromptPresenter(clickhouse);
  const result = await presenter.listGenerations({
    environmentId: environment.id,
    promptSlug,
    promptVersions: versions.length > 0 ? versions : undefined,
    startTime,
    endTime,
    cursor: cursorParam,
    responseModels: models.length > 0 ? models : undefined,
    operations: operations.length > 0 ? operations : undefined,
    providers: providers.length > 0 ? providers : undefined,
  });

  return json(result satisfies GenerationsResponse);
};
