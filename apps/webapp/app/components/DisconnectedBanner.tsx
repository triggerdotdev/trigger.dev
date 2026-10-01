import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { useLoaderDisconnected } from "~/hooks/useLoaderDisconnected";
import { Button } from "~/components/primitives/Buttons";

export function DisconnectedBanner() {
  const revalidator = useRevalidator();
  const disconnected = useLoaderDisconnected();

  if (!disconnected) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded border border-warning/30 bg-background-bright px-4 py-2 text-sm text-text-bright shadow-lg"
    >
      <span>Connection lost. Your data may be out of date.</span>
      <Button
        type="button"
        variant="minimal/small"
        LeadingIcon={ArrowPathIcon}
        aria-label="Refresh"
        tooltip="Refresh"
        onClick={() => revalidator.revalidate()}
      />
    </div>
  );
}
