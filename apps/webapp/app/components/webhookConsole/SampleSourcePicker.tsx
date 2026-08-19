import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { Input } from "~/components/primitives/Input";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";
import {
  type WebhookProviderMeta,
  type WebhookSampleMeta,
  type loader as samplesLoader,
} from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.samples";

export function SampleSourcePicker({
  samplesPath,
  endpointSource,
  onLoad,
}: {
  samplesPath: string;
  /** The endpoint's provider (e.g. "github"); pre-selected in the producer list. */
  endpointSource?: string;
  onLoad: (body: string, headers: Record<string, string>) => void;
}) {
  const listFetcher = useTypedFetcher<typeof samplesLoader>();
  const bodyFetcher = useTypedFetcher<typeof samplesLoader>();
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [producerQuery, setProducerQuery] = useState("");
  const [topicQuery, setTopicQuery] = useState("");

  useEffect(() => {
    if (listFetcher.state === "idle" && listFetcher.data === undefined) {
      listFetcher.load(samplesPath);
    }
  }, [listFetcher, samplesPath]);

  useEffect(() => {
    const data = bodyFetcher.data;
    if (data?.kind === "body") {
      onLoad(data.body, data.extraHeaders ?? {});
    }
  }, [bodyFetcher.data, onLoad]);

  const manifest = listFetcher.data?.kind === "manifest" ? listFetcher.data : undefined;
  const providers = manifest?.providers;
  const samples = manifest?.samples;
  const listLoading = listFetcher.data === undefined;

  useEffect(() => {
    if (!providers || providers.length === 0) return;
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setSelectedProvider((current) => {
      if (current && providers.some((p) => p.id === current)) return current;
      if (endpointSource && providers.some((p) => p.id === endpointSource)) return endpointSource;
      return null;
    });
  }, [providers, endpointSource]);

  const filteredProviders = useMemo(() => {
    if (!providers) return [];

    const query = producerQuery.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter(
      (p) => p.label.toLowerCase().includes(query) || (p.category ?? "").includes(query)
    );
  }, [providers, producerQuery]);

  const groupedProviders = useMemo(() => {
    const groups = new Map<string, WebhookProviderMeta[]>();
    for (const provider of filteredProviders) {
      const key = provider.category ?? "other";
      const group = groups.get(key) ?? [];
      group.push(provider);
      groups.set(key, group);
    }
    return [...groups.entries()];
  }, [filteredProviders]);

  const events = (samples ?? [])
    .filter((item) => item.provider === selectedProvider)
    .filter((item) => {
      const query = topicQuery.trim().toLowerCase();
      return !query || item.eventType.toLowerCase().includes(query);
    });

  const [loadingEventType, setLoadingEventType] = useState<string | undefined>(undefined);

  function selectEvent(item: WebhookSampleMeta) {
    setLoadingEventType(item.eventType);
    const query = new URLSearchParams({ provider: item.provider, eventType: item.eventType });
    bodyFetcher.load(`${samplesPath}?${query.toString()}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-charcoal-900">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
        <div className="flex min-h-0 flex-col border-r border-grid-dimmed">
          <SearchInput
            placeholder="Webhook producer"
            value={producerQuery}
            onChange={setProducerQuery}
          />
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            {listLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="size-4" />
              </div>
            ) : filteredProviders.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-dimmed">No providers</p>
            ) : (
              groupedProviders.map(([category, group]) => (
                <div key={category}>
                  <p className="sticky top-0 z-10 bg-charcoal-900 px-3 pb-1 pt-3 text-xs font-medium text-text-dimmed">
                    {group[0]?.categoryLabel ?? category}
                  </p>
                  {group.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => setSelectedProvider(provider.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                        provider.id === selectedProvider
                          ? "bg-indigo-500/15 text-indigo-400"
                          : "text-text-bright hover:bg-charcoal-800"
                      )}
                    >
                      <span className="flex-1 truncate">{provider.label}</span>
                      <span className="shrink-0 text-xxs tabular-nums text-text-dimmed">
                        {provider.eventCount}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <SearchInput
            placeholder="Webhook type or topic"
            value={topicQuery}
            onChange={setTopicQuery}
          />
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            {!selectedProvider ? (
              <p className="px-3 py-6 text-center text-xs text-text-dimmed">
                Select a producer to see its events.
              </p>
            ) : events.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-dimmed">No matching events</p>
            ) : (
              events.map((item) => (
                <button
                  key={`${item.provider}:${item.eventType}`}
                  type="button"
                  onClick={() => selectEvent(item)}
                  disabled={bodyFetcher.state !== "idle"}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-charcoal-800 disabled:opacity-60"
                >
                  <span className="truncate font-mono text-sm text-text-bright">
                    {item.eventType}
                  </span>
                  {bodyFetcher.state !== "idle" && loadingEventType === item.eventType ? (
                    <Spinner className="size-3.5 shrink-0" />
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-grid-dimmed px-3 py-2 text-xxs text-text-dimmed">
        Curated event payloads. Signed with this endpoint's config at send time.
      </div>
    </div>
  );
}

function SearchInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="border-b border-grid-dimmed p-2">
      <Input
        variant="small"
        placeholder={placeholder}
        value={value}
        icon={MagnifyingGlassIcon}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
