import { PGliteProvider } from "@electric-sql/pglite-react";
import { ReactNode, useEffect, useState } from "react";
import { createClient, PGClient } from "./client";
import { useAppOrigin } from "~/root";

export function PgProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [db, setDb] = useState<PGClient | null>(null);
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

  usePgSync({ pg: db, projectId });

  if (isLoading) {
    return <div>Loading database...</div>;
  }

  if (!db) {
    return <div>Failed to initialize database</div>;
  }

  return <PGliteProvider db={db}>{children}</PGliteProvider>;
}

function usePgSync({ pg, projectId }: { pg: PGClient | null; projectId: string }) {
  const origin = useAppOrigin();

  useEffect(() => {
    if (!pg) return;

    let shape: { unsubscribe: () => void };

    const setupSync = async () => {
      try {
        shape = await pg.electric.syncShapeToTable({
          shape: { url: `${origin}/sync/${projectId}/runs` },
          table: "TaskRun",
          primaryKey: ["id"],
        });
      } catch (error) {
        console.error("Error syncing shape:", error);
      }
    };

    setupSync();

    return () => {
      if (shape) {
        shape.unsubscribe();
      }
    };
  }, [projectId, pg]);
}
