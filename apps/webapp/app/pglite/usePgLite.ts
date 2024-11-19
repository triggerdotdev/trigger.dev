import { live } from "@electric-sql/pglite/live";
import { PGliteWorker } from "@electric-sql/pglite/worker";
import { useEffect, useRef } from "react";
import { client } from "./client";
import { PGlite } from "@electric-sql/pglite";

type PGClientWithLive = PGlite & {
  live: typeof live;
};

// Create a single shared instance outside of the hook
let globalClient: PGClientWithLive | undefined;

export function usePglite() {
  const initialized = useRef(false);

  useEffect(() => {
    console.log("Get client");
    if (!globalClient && !initialized.current) {
      initialized.current = true;
      // globalClient = new PGliteWorker(
      //   new Worker("/worker.js", {
      //     type: "module",
      //   }),
      //   {
      //     extensions: {
      //       live,
      //     },
      //   }
      // ) as PGClientWithLive;
      client().then((c) => {
        globalClient = c as PGClientWithLive;
        console.log("Client initialized", globalClient);
      });
    }

    console.log("Client", globalClient);
  }, []);

  return {
    isLoading: !globalClient,
    client: globalClient,
  };
}
