import { type SampleRecord } from "../sampleRecord.js";

/**
 * Firecrawl samples. Firecrawl signs with a custom `X-Firecrawl-Signature: sha256=<hex>` scheme (not
 * one of our presets), so no `presetId` is set. Every event shares one envelope: `success`, `type`,
 * `id` (the job id), `webhookId` (the delivery id, the same on retries), `data` (usually an array,
 * empty on lifecycle events), `metadata` (echoed from the webhook config on the originating request)
 * and `error` when `success` is false.
 */
export const samples: SampleRecord[] = [
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "crawl.started",
    name: "Crawl started",
    description: "A crawl job began processing.",
    body: {
      success: true,
      type: "crawl.started",
      webhookId: "5f1c0000-0000-4000-8000-000000000001",
      id: "7d3f9a21-4c8e-4b6a-9f2d-1e5c8b3a7d40",
      data: [],
      metadata: { tenantId: "acme", source: "docs-sync" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "crawl.page",
    name: "Crawl page scraped",
    description:
      "One page was scraped during a crawl; `data` holds its markdown and page metadata.",
    body: {
      success: true,
      type: "crawl.page",
      webhookId: "5f1c0000-0000-4000-8000-000000000002",
      id: "7d3f9a21-4c8e-4b6a-9f2d-1e5c8b3a7d40",
      data: [
        {
          markdown:
            "# Getting started\n\nInstall the CLI and run `acme init` to scaffold a new project.",
          metadata: {
            title: "Getting started | Acme Docs",
            description: "Install the Acme CLI and scaffold your first project.",
            url: "https://docs.acme.dev/getting-started",
            statusCode: 200,
            contentType: "text/html; charset=utf-8",
            scrapeId: "b81c4e27-3a9f-4d1b-8e6c-5f2a9d7b3c11",
            sourceURL: "https://docs.acme.dev/getting-started",
            proxyUsed: "basic",
            cacheState: "miss",
            cachedAt: "2026-10-14T09:21:47.512Z",
            creditsUsed: 1,
          },
        },
      ],
      metadata: { tenantId: "acme", source: "docs-sync" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "crawl.completed",
    name: "Crawl completed",
    description: "A crawl job finished and every page has been processed.",
    body: {
      success: true,
      type: "crawl.completed",
      webhookId: "5f1c0000-0000-4000-8000-000000000003",
      id: "7d3f9a21-4c8e-4b6a-9f2d-1e5c8b3a7d40",
      data: [],
      metadata: { tenantId: "acme", source: "docs-sync" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "batch_scrape.page",
    name: "Batch scrape page scraped",
    description: "One URL in a batch scrape finished; `data` holds its markdown and page metadata.",
    body: {
      success: true,
      type: "batch_scrape.page",
      webhookId: "5f1c0000-0000-4000-8000-000000000004",
      id: "c4a81f9e-2b7d-4e3a-8c5f-9d1b6e4a2f73",
      data: [
        {
          markdown: "# Pricing\n\nStarter: $19/mo. Team: $99/mo. Enterprise: contact sales.",
          metadata: {
            title: "Pricing | Example Analytics",
            description: "Plans for teams of every size.",
            url: "https://example-analytics.com/pricing",
            statusCode: 200,
            contentType: "text/html",
            scrapeId: "e93d2b5a-7f1c-4a8e-b6d4-3c9f1a7e5b22",
            sourceURL: "https://example-analytics.com/pricing",
            proxyUsed: "basic",
            cacheState: "hit",
            cachedAt: "2026-10-13T22:04:18.903Z",
            creditsUsed: 1,
          },
        },
      ],
      metadata: { competitor: "example-analytics" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "extract.completed",
    name: "Extract completed",
    description:
      "An extract job finished; `data` holds the structured result, usage and per-field sources.",
    body: {
      success: true,
      type: "extract.completed",
      webhookId: "5f1c0000-0000-4000-8000-000000000005",
      id: "5b2e8d4f-9a1c-4f7e-a3b6-8c4d2e9f1a05",
      data: [
        {
          success: true,
          data: { companyName: "Northwind Robotics", headquarters: "Austin, TX", employees: 240 },
          extractId: "5b2e8d4f-9a1c-4f7e-a3b6-8c4d2e9f1a05",
          llmUsage: 0.0031472,
          totalUrlsScraped: 2,
          sources: {
            companyName: ["https://northwind-robotics.example/about"],
            headquarters: ["https://northwind-robotics.example/about"],
            employees: ["https://northwind-robotics.example/careers"],
          },
        },
      ],
      metadata: { leadId: "lead_88214" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "firecrawl",
    providerLabel: "Firecrawl",
    eventType: "agent.failed",
    name: "Agent failed",
    description:
      "An agent job stopped at its credit limit; `error` gives the reason and `data` the credits used.",
    body: {
      success: false,
      type: "agent.failed",
      webhookId: "5f1c0000-0000-4000-8000-000000000006",
      id: "a9f3c1e7-6d2b-4b8a-9e4f-2c7d5a1b8e36",
      data: [
        {
          creditsUsed: 50,
          stopReason: "credit_limit_reached",
          partial: { company: "Northwind Robotics", industry: "Industrial automation" },
          message: "The founding year could not be determined before the credit limit was reached.",
        },
      ],
      error: "Max credits exceeded",
      metadata: { leadId: "lead_88214" },
    },
    docsUrl: "https://docs.firecrawl.dev/webhooks/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
