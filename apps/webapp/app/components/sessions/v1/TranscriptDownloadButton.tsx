import { ArrowDownTrayIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import * as Property from "~/components/primitives/PropertyTable";

export function TranscriptDownloadButton({
  resourcePath,
  initiallyAvailable,
}: {
  resourcePath: string;
  initiallyAvailable: boolean;
}) {
  const [checkedAvailability, setAvailability] = useState<
    "loading" | "available" | "missing" | "error"
  >("loading");
  const availability = initiallyAvailable ? "available" : checkedAvailability;
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (initiallyAvailable) return;
    const controller = new AbortController();
    fetch(`${resourcePath}?check=1`, { signal: controller.signal })
      .then(async (response) => {
        // A proxy may return HTML; all failed checks use the same actionable message.
        if (response.redirected || !response.ok) throw new Error("Availability check failed");
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== "object" ||
          !("available" in body) ||
          typeof body.available !== "boolean"
        ) {
          throw new Error("Invalid availability response");
        }
        if (!controller.signal.aborted) setAvailability(body.available ? "available" : "missing");
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailability("error");
      });
    return () => controller.abort();
  }, [resourcePath, initiallyAvailable, retry]);

  if (availability === "loading" || availability === "missing") return null;

  return (
    <Property.Item>
      <Property.Label>Transcript</Property.Label>
      <Property.Value>
        {availability === "available" ? (
          <LinkButton
            to={resourcePath}
            download
            variant="secondary/small"
            LeadingIcon={ArrowDownTrayIcon}
            aria-label="Download transcript"
          >
            Download
          </LinkButton>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <span role="alert" className="text-xs">
              Could not check transcript availability.
            </span>
            <Button
              variant="secondary/small"
              onClick={() => {
                setAvailability("loading");
                setRetry((value) => value + 1);
              }}
            >
              Retry
            </Button>
          </div>
        )}
      </Property.Value>
    </Property.Item>
  );
}
