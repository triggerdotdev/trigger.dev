import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

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
