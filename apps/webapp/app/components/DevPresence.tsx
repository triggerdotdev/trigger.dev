import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useDebounce } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

// Define Context types
type DevPresenceContextType = {
  lastSeen: Date | null;
  isConnected: boolean;
};

// Create Context with default values
const DevPresenceContext = createContext<DevPresenceContextType>({
  lastSeen: null,
  isConnected: false,
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
    `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dev/presence`,
    {
      event: "presence",
      disabled: !enabled,
    }
  );

  const [lastSeen, setLastSeen] = useState<Date | null>(null);

  const debouncer = useDebounce((seen: Date | null) => {
    setLastSeen(seen);
  }, 3_000);

  useEffect(() => {
    // If disabled or no events, set lastSeen to null
    if (!enabled || streamedEvents === null) {
      debouncer(null);
      return;
    }

    try {
      const data = JSON.parse(streamedEvents) as any;
      if ("lastSeen" in data && data.lastSeen) {
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
  }, [streamedEvents, enabled]);

  // Calculate isConnected and memoize the context value
  const contextValue = useMemo(() => {
    const isConnected = enabled && lastSeen !== null && lastSeen > new Date(Date.now() - 120_000);
    return { lastSeen, isConnected };
  }, [lastSeen, enabled]);

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
