import { useSearchParams } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";
import { getMissingLlmModels } from "~/services/admin/missingLlmModels.server";

const LOOKBACK_OPTIONS = [
  { label: "1 hour", value: 1 },
  { label: "6 hours", value: 6 },
  { label: "24 hours", value: 24 },
  { label: "7 days", value: 168 },
  { label: "30 days", value: 720 },
];

const SearchParams = z.object({
  lookbackHours: z.coerce.number().optional(),
});

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const url = new URL(request.url);
    const lookbackHours = parseInt(url.searchParams.get("lookbackHours") ?? "24", 10);

    let models: Awaited<ReturnType<typeof getMissingLlmModels>> = [];
    let error: string | undefined;

    try {
      models = await getMissingLlmModels({ lookbackHours });
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to query ClickHouse";
    }

    return typedjson({ models, lookbackHours, error });
  }
);

export default function AdminLlmModelsMissingRoute() {
  const { models, lookbackHours, error } = useTypedLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-text-bright">Missing LLM Models</h2>
          <LinkButton to="/admin/llm-models" variant="tertiary/small">
            Back to models
          </LinkButton>
        </div>

        <Paragraph className="text-text-dimmed">
          Models appearing in spans without cost enrichment. These models need pricing data added.
        </Paragraph>

        {/* Lookback selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-dimmed">Lookback:</span>
          {LOOKBACK_OPTIONS.map((opt) => (
            <LinkButton
              key={opt.value}
              to={`/admin/llm-models/missing?lookbackHours=${opt.value}`}
              variant={lookbackHours === opt.value ? "primary/small" : "tertiary/small"}
            >
              {opt.label}
            </LinkButton>
          ))}
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <Paragraph className="text-text-dimmed">
          {models.length} unpriced model{models.length !== 1 ? "s" : ""} found in the last{" "}
          {lookbackHours < 24
            ? `${lookbackHours}h`
            : lookbackHours < 168
              ? `${lookbackHours / 24}d`
              : `${Math.round(lookbackHours / 24)}d`}
        </Paragraph>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Model Name</TableHeaderCell>
              <TableHeaderCell>Provider</TableHeaderCell>
              <TableHeaderCell>Span Count</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.length === 0 ? (
              <TableBlankRow colSpan={4}>
                <Paragraph>All models have pricing data</Paragraph>
              </TableBlankRow>
            ) : (
              models.map((m) => (
                <MissingModelRow key={`${m.system}/${m.model}`} model={m} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Row component with link to detail page
// ---------------------------------------------------------------------------

function MissingModelRow({ model: m }: { model: { model: string; system: string; count: number } }) {
  return (
    <TableRow>
      <TableCell>
        <LinkButton
          to={`/admin/llm-models/missing/${encodeURIComponent(m.model)}`}
          variant="minimal/small"
          className="font-mono text-sm text-indigo-500 underline"
        >
          {m.model}
        </LinkButton>
      </TableCell>
      <TableCell>
        <span className="text-xs text-text-dimmed">{m.system || "-"}</span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-text-bright">{m.count.toLocaleString()}</span>
      </TableCell>
      <TableCell>
        <LinkButton
          to={`/admin/llm-models/missing/${encodeURIComponent(m.model)}`}
          variant="tertiary/small"
        >
          Details
        </LinkButton>
      </TableCell>
    </TableRow>
  );
}
