import {
  categoryLabel,
  categoryOrder,
  getProvider,
  getSample,
  sampleManifest,
} from "@internal/webhook-sources";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

export type WebhookSampleMeta = {
  provider: string;
  providerLabel?: string;
  presetId?: string;
  eventType: string;
  name: string;
  description?: string;
};

/** Provider metadata joined from the registry, for the producer pane. */
export type WebhookProviderMeta = {
  id: string;
  label: string;
  category?: string;
  categoryLabel?: string;
  docsUrl?: string;
  /** Set when the provider maps to a verifier preset (i.e. round-trippable / first-class). */
  preset?: string;
  eventCount: number;
};

export type WebhookSamplesData =
  | { kind: "manifest"; providers: WebhookProviderMeta[]; samples: WebhookSampleMeta[] }
  | { kind: "body"; body: string; extraHeaders?: Record<string, string> }
  | { kind: "error"; error: string };

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project)
    return typedjson({ kind: "error", error: "Project not found" } as WebhookSamplesData);

  if (!user.admin && !user.isImpersonating) {
    const org = await $replica.organization.findFirst({
      where: { id: project.organizationId },
      select: { featureFlags: true },
    });
    const enabled = await flag({
      key: FEATURE_FLAG.hasWebhooksAccess,
      defaultValue: false,
      overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
    });
    if (!enabled) throw new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? undefined;
  const eventType = url.searchParams.get("eventType") ?? undefined;

  if (provider && eventType) {
    const sample = getSample(provider, eventType);
    if (!sample)
      return typedjson({ kind: "error", error: "Sample not found" } as WebhookSamplesData);
    return typedjson({
      kind: "body",
      body: JSON.stringify(sample.body, null, 2),
      extraHeaders: sample.extraHeaders,
    } as WebhookSamplesData);
  }

  const manifest = sampleManifest().filter((sample) => getProvider(sample.provider));

  const items: WebhookSampleMeta[] = manifest.map((sample) => {
    const entry = getProvider(sample.provider);
    return {
      provider: sample.provider,
      providerLabel: entry?.label ?? sample.providerLabel,
      presetId: sample.presetId,
      eventType: sample.eventType,
      name: sample.name,
      description: sample.description,
    };
  });

  const providerMap = new Map<string, WebhookProviderMeta>();
  for (const sample of manifest) {
    const existing = providerMap.get(sample.provider);
    if (existing) {
      existing.eventCount += 1;
      continue;
    }
    const entry = getProvider(sample.provider);
    providerMap.set(sample.provider, {
      id: sample.provider,
      label: entry?.label ?? sample.providerLabel ?? titleCase(sample.provider),
      category: entry?.category,
      categoryLabel: entry ? categoryLabel(entry.category) : undefined,
      docsUrl: entry?.docsUrl,
      preset: entry?.preset,
      eventCount: 1,
    });
  }

  const providers = [...providerMap.values()].sort((a, b) => {
    const cat = categoryOrder(a.category ?? "") - categoryOrder(b.category ?? "");
    return cat !== 0 ? cat : a.label.localeCompare(b.label);
  });

  return typedjson({ kind: "manifest", providers, samples: items } as WebhookSamplesData);
}
