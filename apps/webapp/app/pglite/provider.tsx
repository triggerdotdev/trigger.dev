import { PGliteProvider } from "@electric-sql/pglite-react";
import { createClient } from ".";
import { ReactNode, useState, useEffect } from "react";

export function PgProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    createClient()
      .then((client) => {
        setDb(client);
        setIsLoading(false);
      })
      .catch((error) => {
        console.error("Failed to initialize database:", error);
        setIsLoading(false);
      });
  }, []);

  if (isLoading) {
    return <div>Loading database...</div>;
  }

  if (!db) {
    return <div>Failed to initialize database</div>;
  }

  return <PGliteProvider db={db}>{children}</PGliteProvider>;
}
