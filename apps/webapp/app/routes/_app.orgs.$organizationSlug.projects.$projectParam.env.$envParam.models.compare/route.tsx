import { ArrowsRightLeftIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ModelComparisonItem,
  ModelRegistryPresenter,
} from "~/presenters/v3/ModelRegistryPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUserId } from "~/services/session.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { EnvironmentParamSchema, v3ModelsPath } from "~/utils/pathBuilder";
import { formatModelCost } from "~/utils/modelFormatters";
import { formatNumberCompact } from "~/utils/numberFormatter";

export const meta: MetaFunction = () => {
  return [{ title: "Compare Models | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const url = new URL(request.url);
  const modelsParam = url.searchParams.get("models") ?? "";
  const responseModels = modelsParam.split(",").filter(Boolean).slice(0, 4);

  if (responseModels.length < 2) {
    return typedjson({ comparison: [] as ModelComparisonItem[], models: responseModels });
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard");
  const presenter = new ModelRegistryPresenter(clickhouse);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const comparison = await presenter.getModelComparison(responseModels, sevenDaysAgo, now);

  return typedjson({ comparison, models: responseModels });
};

type ComparisonRow = {
  label: string;
  values: string[];
  bestIndex?: number;
};

function buildRows(models: string[], comparison: ModelComparisonItem[]): ComparisonRow[] {
  const dataMap = new Map<string, ModelComparisonItem>();
  for (const item of comparison) {
    dataMap.set(item.responseModel, item);
  }

  const getValue = (model: string, key: keyof ModelComparisonItem) => {
    const d = dataMap.get(model);
    return d ? d[key] : 0;
  };

  const findBest = (values: number[], lowerIsBetter: boolean) => {
    if (values.every((v) => v === 0)) return undefined;
    const filtered = values.map((v, i) => ({ v, i })).filter(({ v }) => v > 0);
    if (filtered.length === 0) return undefined;
    const best = lowerIsBetter
      ? filtered.reduce((a, b) => (a.v < b.v ? a : b))
      : filtered.reduce((a, b) => (a.v > b.v ? a : b));
    return best.i;
  };

  const callValues = models.map((m) => Number(getValue(m, "callCount")));
  const ttfcP50Values = models.map((m) => Number(getValue(m, "ttfcP50")));
  const ttfcP90Values = models.map((m) => Number(getValue(m, "ttfcP90")));
  const tpsP50Values = models.map((m) => Number(getValue(m, "tpsP50")));
  const tpsP90Values = models.map((m) => Number(getValue(m, "tpsP90")));
  const costValues = models.map((m) => Number(getValue(m, "totalCost")));

  return [
    {
      label: "Provider",
      values: models.map((m) => dataMap.get(m)?.genAiSystem ?? "—"),
    },
    {
      label: "Total Calls (7d)",
      values: callValues.map((v) => formatNumberCompact(v)),
      bestIndex: findBest(callValues, false),
    },
    {
      label: "p50 TTFC",
      values: ttfcP50Values.map((v) => (v > 0 ? `${v.toFixed(0)}ms` : "—")),
      bestIndex: findBest(ttfcP50Values, true),
    },
    {
      label: "p90 TTFC",
      values: ttfcP90Values.map((v) => (v > 0 ? `${v.toFixed(0)}ms` : "—")),
      bestIndex: findBest(ttfcP90Values, true),
    },
    {
      label: "Tokens/sec (p50)",
      values: tpsP50Values.map((v) => (v > 0 ? v.toFixed(0) : "—")),
      bestIndex: findBest(tpsP50Values, false),
    },
    {
      label: "Tokens/sec (p90)",
      values: tpsP90Values.map((v) => (v > 0 ? v.toFixed(0) : "—")),
      bestIndex: findBest(tpsP90Values, false),
    },
    {
      label: "Total Cost (7d)",
      values: costValues.map((v) => (v > 0 ? formatModelCost(v) : "—")),
      bestIndex: findBest(costValues, true),
    },
  ];
}

export default function ModelComparePage() {
  const { comparison, models } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const rows = buildRows(models, comparison);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Compare Models"
          backButton={{
            to: v3ModelsPath(organization, project, environment),
            text: "Models",
          }}
        />
      </NavBar>
      <PageBody scrollable>
        {models.length < 2 ? (
          <MainCenteredContainer className="max-w-md">
            <InfoPanel
              title="Compare models side by side"
              icon={ArrowsRightLeftIcon}
              iconClassName="text-indigo-500"
              panelClassName="max-w-md"
            >
              <p className="text-sm text-text-dimmed">
                Select 2-4 models from the catalog to compare their pricing, capabilities, and
                performance metrics side by side.
              </p>
              <LinkButton
                to={v3ModelsPath(organization, project, environment)}
                variant="primary/small"
                className="mt-3"
              >
                Browse models
              </LinkButton>
            </InfoPanel>
          </MainCenteredContainer>
        ) : (
          <div className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Metric</TableHeaderCell>
                  {models.map((model) => (
                    <TableHeaderCell key={model} alignment="right">
                      {model}
                    </TableHeaderCell>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell>
                      <span className="text-xs font-medium text-text-dimmed">{row.label}</span>
                    </TableCell>
                    {row.values.map((value, i) => (
                      <TableCell key={i} alignment="right">
                        <span
                          className={`tabular-nums ${
                            row.bestIndex === i
                              ? "font-medium text-success"
                              : "text-text-bright"
                          }`}
                        >
                          {value}
                        </span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}
