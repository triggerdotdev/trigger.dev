import { useEffect, useState } from "react";
import { ConnectedIcon, DisconnectedIcon } from "~/assets/icons/ConnectionIcons";
import { useDebounce } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "./primitives/Dialog";
import { Button, LinkButton } from "./primitives/Buttons";
import connectedImage from "../assets/images/cli-connected.png";
import disconnectedImage from "../assets/images/cli-disconnected.png";
import { Paragraph } from "./primitives/Paragraph";
import { PackageManagerProvider, TriggerDevStepV3 } from "./SetupCommands";
import { docsPath } from "~/utils/pathBuilder";
import { BookOpenIcon } from "@heroicons/react/20/solid";

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
        <div className="mt-2 flex flex-col gap-3 px-2">
          <div className="flex flex-col items-center justify-center gap-6 px-6 py-10">
            <img
              src={isConnected ? connectedImage : disconnectedImage}
              alt={isConnected ? "Connected" : "Disconnected"}
              width={282}
              height={45}
            />
            <Paragraph variant="small" className={isConnected ? "text-success" : "text-error"}>
              {isConnected
                ? "Your local dev server is connected to Trigger.dev"
                : "Your local dev server is not connected to Trigger.dev"}
            </Paragraph>
          </div>
          {isConnected ? null : (
            <div className="space-y-3">
              <PackageManagerProvider>
                <TriggerDevStepV3 />
              </PackageManagerProvider>
              <Paragraph variant="small">
                Run this CLI `dev` command to connect to the Trigger.dev servers to start developing
                locally. Keep it running while you develop to stay connected.
              </Paragraph>
            </div>
          )}
        </div>
        <DialogFooter>
          <LinkButton variant="tertiary/medium" LeadingIcon={BookOpenIcon} to={docsPath("cli-dev")}>
            CLI docs
          </LinkButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
