import { useEffect, useState } from "react";
import { ConnectedIcon, DisconnectedIcon } from "~/assets/icons/ConnectionIcons";
import { useDebounce } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "./primitives/Dialog";
import { Button } from "./primitives/Buttons";

export function useDevPresence() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const streamedEvents = useEventSource(
    `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dev/presence`,
    {
      event: "presence",
    }
  );

  const [lastSeen, setLastSeen] = useState<Date | null>(null);

  const debouncer = useDebounce((seen: Date | null) => {
    setLastSeen(seen);
  }, 3_000);

  useEffect(() => {
    if (streamedEvents === null) {
      debouncer(null);
      return;
    }

    try {
      const data = JSON.parse(streamedEvents) as any;
      if ("lastSeen" in data && data.lastSeen) {
        // Parse the timestamp string into a Date object
        try {
          const lastSeenDate = new Date(data.lastSeen);
          debouncer(lastSeenDate);
        } catch (error) {
          console.log("DevPresence: Failed to parse lastSeen timestamp", { error });
          debouncer(null);
        }
      } else {
        debouncer(null);
      }
    } catch (error) {
      console.log("DevPresence: Failed to parse presence message", { error });
      debouncer(null);
    }
  }, [streamedEvents]);

  return { lastSeen };
}

export function DevPresence() {
  const { lastSeen } = useDevPresence();
  const isConnected = lastSeen && lastSeen > new Date(Date.now() - 120_000);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="minimal/small"
          className="px-1"
          LeadingIcon={
            isConnected ? (
              <ConnectedIcon className="size-5" />
            ) : (
              <DisconnectedIcon className="size-5" />
            )
          }
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {isConnected
            ? "Your dev server is connected to Trigger.dev"
            : "Your dev server is not connected to Trigger.dev"}
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-4"></div>
      </DialogContent>
    </Dialog>
  );
}
