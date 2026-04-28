import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useNewRunsCount } from "~/hooks/useNewRunsCount";

const LIVE_INTERVAL_MS = 3000;

export function RunsLiveControl({
  isLive,
  onChange,
  topRowId,
  countNewUrl,
}: {
  isLive: boolean;
  onChange: (next: boolean) => void;
  topRowId: string | undefined;
  countNewUrl: string;
}) {
  const revalidator = useRevalidator();

  // When live, the loader auto-revalidates and the count banner is hidden.
  // When not live, we poll for new runs and show the banner if any exist.
  useAutoRevalidate({ interval: LIVE_INTERVAL_MS, disabled: !isLive });

  const { count, hasMore } = useNewRunsCount({
    sinceId: topRowId,
    countNewUrl,
    intervalMs: LIVE_INTERVAL_MS,
    disabled: isLive,
  });

  const showCountBanner = !isLive && count > 0;
  const label = hasMore ? `${count}+` : String(count);
  const noun = count === 1 && !hasMore ? "run" : "runs";

  return (
    <>
      {showCountBanner && (
        <Button
          variant="secondary/small"
          onClick={() => revalidator.revalidate()}
          LeadingIcon={ArrowPathIcon}
          tooltip="Load new runs. Click the Live button to enable auto-refresh."
        >
          <span className="text-text-bright">
            {label} new {noun}, click to update
          </span>
        </Button>
      )}
      <Button
        variant="secondary/small"
        onClick={() => onChange(!isLive)}
        tooltip={isLive ? "Pause live updates" : "Auto-refresh new runs"}
        LeadingIcon={() => <LiveDot isLive={isLive} />}
      >
        <span className="text-text-bright">Live</span>
      </Button>
    </>
  );
}

function LiveDot({ isLive }: { isLive: boolean }) {
  if (!isLive) {
    return <span className="size-2 rounded-full bg-charcoal-500" aria-hidden />;
  }

  return (
    <span className="relative flex size-2 items-center justify-center" aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-rose-500 opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-rose-500" />
    </span>
  );
}
