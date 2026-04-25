import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Form, useFetcher, Link } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { PaginationControls } from "~/components/primitives/Pagination";
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
import { prisma } from "~/db.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder.server";
import { createSearchParams } from "~/utils/searchParams";
import { seedLlmPricing, syncLlmCatalog } from "@internal/llm-model-catalog";
import { llmPricingRegistry } from "~/v3/llmPricingRegistry.server";

const PAGE_SIZE = 50;

const SearchParams = z.object({
  page: z.coerce.number().optional(),
  search: z.string().optional(),
});

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const searchParams = createSearchParams(request.url, SearchParams);
    if (!searchParams.success) throw new Error(searchParams.error);
    const { page: rawPage, search } = searchParams.params.getAll();
    const page = rawPage ?? 1;

    const where = {
      projectId: null as string | null,
      ...(search ? { modelName: { contains: search, mode: "insensitive" as const } } : {}),
    };

    const [rawModels, total] = await Promise.all([
      prisma.llmModel.findMany({
        where,
        include: {
          pricingTiers: { include: { prices: true }, orderBy: { priority: "asc" } },
        },
        orderBy: { modelName: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.llmModel.count({ where }),
    ]);

    // Convert Prisma Decimal to plain numbers for serialization
    const models = rawModels.map((m) => ({
      ...m,
      pricingTiers: m.pricingTiers.map((t) => ({
        ...t,
        prices: t.prices.map((p) => ({ ...p, price: Number(p.price) })),
      })),
    }));

    return typedjson({
      models,
      total,
      page,
      pageCount: Math.ceil(total / PAGE_SIZE),
      filters: { search },
    });
  }
);

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const formData = await request.formData();
    const _action = formData.get("_action");

    if (_action === "seed") {
      console.log("[admin] seed action started");
      const result = await seedLlmPricing(prisma);
      console.log(`[admin] seed complete: ${result.modelsCreated} created, ${result.modelsSkipped} skipped, ${result.modelsUpdated} updated`);
      await llmPricingRegistry?.reload();
      console.log("[admin] registry reloaded after seed");
      return typedjson({
        success: true,
        message: `Seeded: ${result.modelsCreated} created, ${result.modelsSkipped} skipped, ${result.modelsUpdated} updated`,
      });
    }

    if (_action === "sync") {
      console.log("[admin] sync catalog action started");
      const result = await syncLlmCatalog(prisma);
      console.log(`[admin] sync complete: ${result.modelsUpdated} updated, ${result.modelsSkipped} skipped`);
      await llmPricingRegistry?.reload();
      console.log("[admin] registry reloaded after sync");
      return typedjson({
        success: true,
        message: `Synced: ${result.modelsUpdated} updated, ${result.modelsSkipped} skipped`,
      });
    }

    if (_action === "reload") {
      console.log("[admin] reload action started");
      await llmPricingRegistry?.reload();
      console.log("[admin] registry reloaded");
      return typedjson({ success: true, message: "Registry reloaded" });
    }

    if (_action === "test") {
      const modelString = formData.get("modelString");
      if (typeof modelString !== "string" || !modelString) {
        return typedjson({ testResult: null });
      }

      // Use the registry's match() which handles prefix stripping automatically
      const matched = llmPricingRegistry?.match(modelString) ?? null;

      return typedjson({
        testResult: {
          modelString,
          match: matched
            ? { friendlyId: matched.friendlyId, modelName: matched.modelName }
            : null,
        },
      });
    }

    if (_action === "delete") {
      const modelId = formData.get("modelId");
      if (typeof modelId === "string") {
        await prisma.llmModel.delete({ where: { id: modelId } });
        await llmPricingRegistry?.reload();
      }
      return typedjson({ success: true });
    }

    return typedjson({ error: "Unknown action" }, { status: 400 });
  }
);

export default function AdminLlmModelsRoute() {
  const { models, filters, page, pageCount, total } =
    useTypedLoaderData<typeof loader>();
  const seedFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const reloadFetcher = useFetcher();
  const testFetcher = useFetcher<{
    testResult?: {
      modelString: string;
      match: { friendlyId: string; modelName: string } | null;
    } | null;
  }>();

  const testResult = testFetcher.data?.testResult;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Form className="flex items-center gap-2">
            <Input
              placeholder="Search models..."
              variant="medium"
              icon={MagnifyingGlassIcon}
              fullWidth={true}
              name="search"
              defaultValue={filters.search}
              autoFocus
            />
            <Button type="submit" variant="secondary/medium">
              Search
            </Button>
          </Form>

          <div className="flex items-center gap-2">
            <seedFetcher.Form method="post">
              <input type="hidden" name="_action" value="seed" />
              <Button
                type="submit"
                variant="tertiary/small"
                disabled={seedFetcher.state !== "idle"}
              >
                {seedFetcher.state !== "idle" ? "Seeding..." : "Seed defaults"}
              </Button>
            </seedFetcher.Form>

            <syncFetcher.Form method="post">
              <input type="hidden" name="_action" value="sync" />
              <Button
                type="submit"
                variant="tertiary/small"
                disabled={syncFetcher.state !== "idle"}
              >
                {syncFetcher.state !== "idle" ? "Syncing..." : "Sync catalog"}
              </Button>
            </syncFetcher.Form>

            <reloadFetcher.Form method="post">
              <input type="hidden" name="_action" value="reload" />
              <Button
                type="submit"
                variant="tertiary/small"
                disabled={reloadFetcher.state !== "idle"}
              >
                {reloadFetcher.state !== "idle" ? "Reloading..." : "Reload registry"}
              </Button>
            </reloadFetcher.Form>

            <LinkButton to="/admin/llm-models/missing" variant="tertiary/small">
              Missing models
            </LinkButton>

            <LinkButton to="/admin/llm-models/new" variant="primary/small">
              Add model
            </LinkButton>
          </div>
        </div>

        {/* Model tester */}
        <div className="rounded-md border border-grid-dimmed bg-charcoal-800 p-3 space-y-2">
          <label className="text-xs font-medium text-text-dimmed">
            Test model string — paste a model name to see which pricing model matches
          </label>
          <testFetcher.Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="_action" value="test" />
            <Input
              name="modelString"
              placeholder="e.g. anthropic/claude-haiku-4-5-20251001, gpt-4o-mini, mistral/mistral-large-3"
              variant="medium"
              fullWidth
              className="font-mono text-xs"
            />
            <Button
              type="submit"
              variant="secondary/small"
              disabled={testFetcher.state !== "idle"}
            >
              Test
            </Button>
          </testFetcher.Form>
          {testResult !== undefined && testResult !== null && (
            <div className="text-xs space-y-1">
              <span className="text-text-dimmed">
                Testing: <span className="font-mono text-text-bright">{testResult.modelString}</span>
              </span>
              {testResult.match ? (
                <div className="text-green-400">
                  Match:{" "}
                  <Link
                    to={`/admin/llm-models/${testResult.match.friendlyId}`}
                    className="underline font-medium"
                  >
                    {testResult.match.modelName}
                  </Link>
                </div>
              ) : (
                <div className="text-red-400">
                  No match found — this model has no pricing data
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <Paragraph className="text-text-dimmed">
            {total} global models (page {page} of {pageCount})
          </Paragraph>
          <PaginationControls currentPage={page} totalPages={pageCount} />
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Model Name</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell>Input $/tok</TableHeaderCell>
              <TableHeaderCell>Output $/tok</TableHeaderCell>
              <TableHeaderCell>Other prices</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.length === 0 ? (
              <TableBlankRow colSpan={5}>
                <Paragraph>No models found</Paragraph>
              </TableBlankRow>
            ) : (
              models.map((model) => {
                // Get default tier prices
                const defaultTier =
                  model.pricingTiers.find((t) => t.isDefault) ?? model.pricingTiers[0];
                const priceMap = defaultTier
                  ? Object.fromEntries(defaultTier.prices.map((p) => [p.usageType, p.price]))
                  : {};
                const inputPrice = priceMap["input"];
                const outputPrice = priceMap["output"];
                const otherPrices = defaultTier
                  ? defaultTier.prices.filter(
                      (p) => p.usageType !== "input" && p.usageType !== "output"
                    )
                  : [];

                return (
                  <TableRow key={model.id}>
                    <TableCell>
                      <Link
                        to={`/admin/llm-models/${model.friendlyId}`}
                        className="font-medium text-indigo-500 underline"
                      >
                        {model.modelName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${
                          model.source === "admin"
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-charcoal-700 text-text-dimmed"
                        }`}
                      >
                        {model.source ?? "default"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-mono text-text-bright">
                        {inputPrice != null ? formatPrice(inputPrice) : "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-mono text-text-bright">
                        {outputPrice != null ? formatPrice(outputPrice) : "-"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {otherPrices.length > 0 ? (
                        <span className="text-xs text-text-dimmed" title={otherPrices.map((p) => p.usageType).join(", ")}>
                          +{otherPrices.length} more
                        </span>
                      ) : (
                        <span className="text-xs text-text-dimmed">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        <PaginationControls currentPage={page} totalPages={pageCount} />
      </div>
    </main>
  );
}

/** Format a per-token price as $/M tokens for readability */
function formatPrice(perToken: number): string {
  const perMillion = perToken * 1_000_000;
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}/M`;
  if (perMillion >= 0.01) return `$${perMillion.toFixed(4)}/M`;
  return `$${perMillion.toFixed(6)}/M`;
}
