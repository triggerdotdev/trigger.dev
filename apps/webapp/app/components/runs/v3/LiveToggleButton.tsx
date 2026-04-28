import { Button } from "~/components/primitives/Buttons";

export function LiveToggleButton({
  isLive,
  onChange,
}: {
  isLive: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Button
      variant="secondary/small"
      onClick={() => onChange(!isLive)}
      tooltip={isLive ? "Pause live updates" : "Auto-refresh new runs"}
      LeadingIcon={() => <LiveDot isLive={isLive} />}
    >
      <span className="text-text-bright">Live</span>
    </Button>
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
