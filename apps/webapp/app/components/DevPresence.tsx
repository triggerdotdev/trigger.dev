import { AnimatePresence, motion } from "framer-motion";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
  CheckingConnectionIcon,
  ConnectedIcon,
  DisconnectedIcon,
} from "~/assets/icons/ConnectionIcons";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { docsPath } from "~/utils/pathBuilder";
import connectedImage from "../assets/images/cli-connected.png";
import disconnectedImage from "../assets/images/cli-disconnected.png";
import { InlineCode } from "./code/InlineCode";
import { Button } from "./primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "./primitives/Dialog";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";
import { PackageManagerProvider, TriggerDevStepV3 } from "./SetupCommands";

// Define Context types
type DevPresenceContextType = {
  isConnected: boolean | undefined;
};

// Create Context with default values
const DevPresenceContext = createContext<DevPresenceContextType>({
  isConnected: undefined,
});

// Provider component with enabled prop
interface DevPresenceProviderProps {
  children: ReactNode;
  enabled?: boolean;
}

export function DevPresenceProvider({ children, enabled = true }: DevPresenceProviderProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Only subscribe to event source if enabled is true
  const streamedEvents = useEventSource(
    `/resources/orgs/${organization.slug}/projects/${project.slug}/dev/presence`,
    {
      event: "presence",
      disabled: !enabled,
    }
  );

  const [isConnected, setIsConnected] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    // If disabled or no events
    if (!enabled || streamedEvents === null) {
      setIsConnected(undefined);
      return;
    }

    try {
      const data = JSON.parse(streamedEvents) as any;
      if ("isConnected" in data && data.isConnected) {
        try {
          setIsConnected(true);
        } catch (error) {
          console.log("DevPresence: Failed to parse lastSeen timestamp", { error });
          setIsConnected(false);
        }
      } else {
        setIsConnected(false);
      }
    } catch (error) {
      console.log("DevPresence: Failed to parse presence message", { error });
      setIsConnected(false);
    }
  }, [streamedEvents, enabled]);

  // Calculate isConnected and memoize the context value
  const contextValue = useMemo(() => {
    return { isConnected };
  }, [isConnected, enabled]);

  return <DevPresenceContext.Provider value={contextValue}>{children}</DevPresenceContext.Provider>;
}

// Custom hook to use the context
export function useDevPresence() {
  const context = useContext(DevPresenceContext);
  if (context === undefined) {
    throw new Error("useDevPresence must be used within a DevPresenceProvider");
  }
  return context;
}

/**
 * We need this for the legacy v1 engine, where we show the banner after a delay if there are no events.
 */
export function useCrossEngineIsConnected({ logCount }: { logCount: number }) {
  const project = useProject();
  const environment = useEnvironment();
  const { isConnected } = useDevPresence();
  const [crossEngineIsConnected, setCrossEngineIsConnected] = useState<boolean | undefined>(
    undefined
  );

  useEffect(() => {
    if (project.engine === "V2") {
      setCrossEngineIsConnected(isConnected);
      return;
    }

    if (project.engine === "V1") {
      if (logCount <= 1) {
        const timer = setTimeout(() => {
          setCrossEngineIsConnected(false);
        }, 5000);
        return () => clearTimeout(timer);
      } else {
        setCrossEngineIsConnected(true);
      }
    }
  }, [environment.type, project.engine, logCount, isConnected]);

  return crossEngineIsConnected;
}

export function ConnectionIcon({ isConnected }: { isConnected: boolean | undefined }) {
  if (isConnected === undefined) {
    return <CheckingConnectionIcon className="size-5" />;
  }
  return isConnected ? (
    <ConnectedIcon className="size-5" />
  ) : (
    <DisconnectedIcon className="size-5" />
  );
}

export function DevPresencePanel({ isConnected }: { isConnected: boolean | undefined }) {
  return (
    <DialogContent>
      <DialogHeader>
        {isConnected === undefined
          ? "Checking connection..."
          : isConnected
          ? "Your dev server is connected"
          : "Your dev server is not connected"}
      </DialogHeader>
      <div className="mt-2 flex flex-col gap-3 px-2">
        <div className="flex flex-col items-center justify-center gap-6 px-6 py-10">
          <img
            src={isConnected === true ? connectedImage : disconnectedImage}
            alt={isConnected === true ? "Connected" : "Disconnected"}
            width={282}
            height={45}
          />
          <Paragraph variant="small" className={isConnected ? "text-success" : "text-error"}>
            {isConnected === undefined
              ? "Checking connection..."
              : isConnected
              ? "Your local dev server is connected to Trigger.dev"
              : "Your local dev server is not connected to Trigger.dev"}
          </Paragraph>
        </div>
        {isConnected ? null : (
          <div className="space-y-3">
            <PackageManagerProvider>
              <TriggerDevStepV3 title="Run this command to connect" />
            </PackageManagerProvider>
            <Paragraph variant="small">
              Run this CLI <InlineCode variant="extra-small">dev</InlineCode> command to connect to
              the Trigger.dev servers to start developing locally. Keep it running while you develop
              to stay connected. Learn more in the{" "}
              <TextLink to={docsPath("cli-dev")}>CLI docs</TextLink>.
            </Paragraph>
          </div>
        )}
      </div>
    </DialogContent>
  );
}

export function DevDisconnectedBanner({ isConnected }: { isConnected: boolean | undefined }) {
  return (
    <Dialog>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="flex"
        >
          {isConnected === false && (
            <DialogTrigger asChild>
              <Button
                variant="minimal/small"
                className="py-1 pl-1 pr-2 text-error"
                LeadingIcon={<ConnectionIcon isConnected={false} />}
              >
                Your local dev server is not connected to Trigger.dev
              </Button>
            </DialogTrigger>
          )}
        </motion.div>
      </AnimatePresence>
      <DevPresencePanel isConnected={isConnected} />
    </Dialog>
  );
}
