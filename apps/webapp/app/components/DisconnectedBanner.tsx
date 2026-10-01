import { RefreshIcon } from "~/assets/icons/RefreshIcon";
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
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded border border-warning/30 bg-background-bright p-2 pl-4 text-sm text-text-bright shadow-lg"
    >
      <span>Connection lost. Your data may be out of date.</span>
      <Button
        type="button"
        variant="minimal/small"
        className="size-6 p-0"
        LeadingIcon={RefreshIcon}
        leadingIconClassName="mx-0 size-4"
        aria-label="Refresh"
        tooltip="Refresh"
        onClick={() => revalidator.revalidate()}
      />
    </div>
  );
}
