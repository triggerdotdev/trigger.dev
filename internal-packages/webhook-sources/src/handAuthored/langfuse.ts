import { type SampleRecord } from "../sampleRecord.js";

/**
 * Langfuse samples. Langfuse signs with its own `x-langfuse-signature` (`t=<seconds>,v1=<hex>`)
 * HMAC-SHA256 scheme, which is not one of our presets, so no `presetId` is set. Every body is a v1
 * envelope (`id`, ISO `timestamp`, `type`, `apiVersion`) and `eventType` is the top-level `type`.
 * Prompt-version bodies add `action` and, when a user triggered the change, `user`, and always put
 * the `prompt` object last. `monitor-alert` nests the alert under `payload` and `project-notification`
 * nests it under `event`, discriminated by `event.eventType`. Shapes follow
 * `packages/shared/src/domain/webhooks.ts` and the monitor and notification schemas in the open-source
 * repo.
 */
export const samples: SampleRecord[] = [
  {
    provider: "langfuse",
    providerLabel: "Langfuse",
    eventType: "prompt-version",
    name: "Prompt version created",
    description: "A new version of a text prompt was created and labeled production.",
    body: {
      id: "cmg8x2k4p0003la07h9q1v6zt",
      timestamp: "2026-10-14T09:21:37.412Z",
      type: "prompt-version",
      apiVersion: "v1",
      action: "created",
      user: {
        name: "Dana Okafor",
        email: "dana@acme.dev",
      },
      prompt: {
        id: "cmg8x2jzr0001la07c3k8m2wd",
        name: "support-triage",
        version: 7,
        projectId: "cm1q9z7h40000kz08r5t2b6xn",
        createdBy: "cm0a4f8e10002mm0612p7y9vq",
        labels: ["production", "latest"],
        prompt:
          "You triage inbound support tickets for {{product}}. Classify the ticket as billing, bug or question and reply in one sentence.",
        type: "text",
        config: { model: "claude-sonnet-5-5", temperature: 0.2 },
        commitMessage: "Tighten the classification instructions",
        tags: ["support"],
        createdAt: "2026-10-14T09:21:36.958Z",
        updatedAt: "2026-10-14T09:21:36.958Z",
      },
    },
    docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "langfuse",
    providerLabel: "Langfuse",
    eventType: "prompt-version",
    name: "Prompt version updated",
    description:
      "A chat prompt version gained the production label (a matching event fires for the version that lost it).",
    body: {
      id: "cmg9b7t1e000bla07w4n2q8hs",
      timestamp: "2026-10-14T15:02:11.087Z",
      type: "prompt-version",
      apiVersion: "v1",
      action: "updated",
      user: {
        name: "Marco Lindqvist",
        email: "marco@acme.dev",
      },
      prompt: {
        id: "cmg2r5v8n0007la07b1x6k3pe",
        name: "critic-agent",
        version: 4,
        projectId: "cm1q9z7h40000kz08r5t2b6xn",
        createdBy: "cm0a4f8e10002mm0612p7y9vq",
        labels: ["production", "staging"],
        prompt: [
          {
            role: "system",
            content: "You are a strict reviewer. Point out factual errors before style issues.",
          },
          { role: "user", content: "Review this draft:\n\n{{draft}}" },
        ],
        type: "chat",
        config: { model: "claude-opus-5-5", max_tokens: 1024 },
        commitMessage: "Improved critic persona",
        tags: ["agents", "review"],
        createdAt: "2026-10-09T11:40:02.315Z",
        updatedAt: "2026-10-14T15:02:10.664Z",
      },
    },
    docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "langfuse",
    providerLabel: "Langfuse",
    eventType: "prompt-version",
    name: "Prompt version deleted",
    description: "An unlabeled prompt version was removed.",
    body: {
      id: "cmg9d0q6y000fla07t8r3m1xa",
      timestamp: "2026-10-14T16:45:59.230Z",
      type: "prompt-version",
      apiVersion: "v1",
      action: "deleted",
      user: {
        name: "Dana Okafor",
        email: "dana@acme.dev",
      },
      prompt: {
        id: "cmg6k1w3c0005la07p2d9v4nf",
        name: "support-triage",
        version: 5,
        projectId: "cm1q9z7h40000kz08r5t2b6xn",
        createdBy: "cm0a4f8e10002mm0612p7y9vq",
        labels: [],
        prompt: "Classify the ticket for {{product}} as billing, bug or question.",
        type: "text",
        config: {},
        commitMessage: null,
        tags: ["support"],
        createdAt: "2026-10-11T08:12:44.501Z",
        updatedAt: "2026-10-12T10:03:27.118Z",
      },
    },
    docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "langfuse",
    providerLabel: "Langfuse",
    eventType: "monitor-alert",
    name: "Monitor alert",
    description: "A monitor on production observations crossed its alert threshold.",
    body: {
      id: "cmg9f3z8a000hla07k6s2w9du",
      timestamp: "2026-10-14T18:00:04.771Z",
      type: "monitor-alert",
      apiVersion: "v1",
      payload: {
        monitorId: "cmg1h8c2x0004la07n7e5r3tb",
        projectId: "cm1q9z7h40000kz08r5t2b6xn",
        permalink:
          "https://cloud.langfuse.com/project/cm1q9z7h40000kz08r5t2b6xn/monitors/cmg1h8c2x0004la07n7e5r3tb",
        dataPermalink:
          "https://cloud.langfuse.com/project/cm1q9z7h40000kz08r5t2b6xn/observations?dateRange=2026-10-14T17%3A00%3A00.000Z_2026-10-14T18%3A00%3A00.000Z",
        message: {
          title: "Error rate above 5% on production generations",
          body: "Error rate is 7.4% over the last 1h (threshold 5%).",
        },
        severity: "ALERT",
        timestamp: "2026-10-14T18:00:00.000Z",
        fromTimestamp: "2026-10-14T17:00:00.000Z",
        toTimestamp: "2026-10-14T18:00:00.000Z",
        view: "observations",
        filters: [
          {
            column: "environment",
            operator: "any of",
            value: ["production"],
            type: "stringOptions",
          },
        ],
        window: "1h",
      },
    },
    docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "langfuse",
    providerLabel: "Langfuse",
    eventType: "project-notification",
    name: "Evaluator blocked",
    description:
      "An LLM-as-a-judge evaluator stopped running because its LLM connection key is invalid.",
    body: {
      id: "cmg9g5b1r000jla07d3y8p6vc",
      timestamp: "2026-10-14T19:12:48.390Z",
      type: "project-notification",
      apiVersion: "v1",
      event: {
        severity: "ALERT",
        projectId: "cm1q9z7h40000kz08r5t2b6xn",
        projectName: "support-copilot",
        resourceId: "cmg3m2n7k0006la07f9h1t5ws",
        resourceName: "helpfulness",
        message:
          'Evaluator "helpfulness" is blocked: the API key for its LLM connection was rejected by the provider.',
        url: "https://cloud.langfuse.com/project/cm1q9z7h40000kz08r5t2b6xn/evals/cmg3m2n7k0006la07f9h1t5ws",
        eventType: "evaluator-blocked",
        blockReason: "LLM_CONNECTION_AUTH_INVALID",
        evalTemplateId: "cmg3m1y4d0005la07q2c8b7rx",
        evaluatorId: "cmg3m2n7k0006la07f9h1t5ws",
      },
    },
    docsUrl: "https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
