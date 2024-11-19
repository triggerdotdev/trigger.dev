import { PGlite } from "@electric-sql/pglite";
import { createClient } from ".";
import { useState, useEffect, useRef } from "react";
import { LiveNamespace } from "@electric-sql/pglite/live";

type Client = PGlite & {
  live: LiveNamespace;
};

export function usePglite() {
  const clientRef = useRef<Client | null>(null);
  const [isLoading, setIsLoading] = useState(!clientRef.current);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (clientRef.current) {
      setIsLoading(false);
      return;
    }

    // Otherwise, create a new client
    createClient()
      .then((newClient) => {
        clientRef.current = newClient;
        setIsLoading(false);
      })
      .catch((error) => {
        console.error("Failed to initialize database:", error);
        setIsLoading(false);
      });
  }, []);

  return { client: clientRef.current, isLoading };
}
