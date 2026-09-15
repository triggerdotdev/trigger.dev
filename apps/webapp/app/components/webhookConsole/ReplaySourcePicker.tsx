import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { DateTime } from "~/components/primitives/DateTime";
import { Spinner } from "~/components/primitives/Spinner";
import { DeliveryStatusBadge } from "~/components/webhookDeliveries/v1/DeliveryStatus";
import { type loader as replaySourceLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.endpoints.$endpointParam.replay-source";

export function ReplaySourcePicker({
  replaySourcePath,
  onLoad,
}: {
  replaySourcePath: string;
  onLoad: (body: string, headers: Record<string, string>) => void;
}) {
  const listFetcher = useTypedFetcher<typeof replaySourceLoader>();
  const payloadFetcher = useTypedFetcher<typeof replaySourceLoader>();

  useEffect(() => {
    if (listFetcher.state === "idle" && listFetcher.data === undefined) {
      listFetcher.load(replaySourcePath);
    }
  }, [listFetcher, replaySourcePath]);

  useEffect(() => {
    const data = payloadFetcher.data;
    if (data?.kind === "payload") {
      onLoad(data.body, data.headers);
    }
  }, [payloadFetcher.data, onLoad]);

  const listLoading =
    listFetcher.state === "loading" ||
    (listFetcher.data === undefined && listFetcher.state !== "idle");
  const list = listFetcher.data?.kind === "list" ? listFetcher.data.deliveries : [];
  const [loadingDeliveryId, setLoadingDeliveryId] = useState<string | undefined>(undefined);

  function selectDelivery(friendlyId: string) {
    setLoadingDeliveryId(friendlyId);
    payloadFetcher.load(`${replaySourcePath}?deliveryId=${encodeURIComponent(friendlyId)}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-grid-dimmed px-3 py-2">
        <span className="text-xs font-medium text-text-dimmed">
          Load a past delivery's payload into the composer
        </span>
        {listLoading ? <Spinner className="size-3.5" /> : null}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {!listLoading && list.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-text-dimmed">
            No past deliveries to replay yet.
          </p>
        ) : (
          list.map((delivery) => (
            <button
              key={delivery.friendlyId}
              type="button"
              onClick={() => selectDelivery(delivery.friendlyId)}
              disabled={payloadFetcher.state !== "idle"}
              className="flex w-full items-center justify-between gap-2 border-b border-grid-dimmed px-3 py-2 text-left hover:bg-charcoal-800 disabled:opacity-60"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs text-text-bright">
                  {delivery.friendlyId}
                </span>
                {delivery.isTest ? (
                  <span className="shrink-0 rounded-sm bg-charcoal-700 px-1 py-0.5 text-xxs font-semibold uppercase tracking-wide text-text-dimmed">
                    Test
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xxs text-text-dimmed">
                  <DateTime date={new Date(delivery.createdAt)} />
                </span>
                {payloadFetcher.state !== "idle" && loadingDeliveryId === delivery.friendlyId ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <DeliveryStatusBadge status={delivery.status as WebhookDeliveryStatus} />
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
