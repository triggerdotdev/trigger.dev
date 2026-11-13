import {
  WaitpointKeyTransactionLane,
  WAITPOINT_KEY_TRANSACTION_POOL_SIZE,
  registerWaitpointKeyTransactionLane,
  type WaitpointKeyTransactionClient,
} from "@internal/run-store";
import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

// Created on first use: a counter made before the global meter provider registers stays a no-op.
const budgetExhaustedCounter = () =>
  singleton("waitpointKeyBudgetExhaustedCounter", () =>
    getMeter("waitpoint-key-lane").createCounter("waitpoint.key_transaction.budget_exhausted", {
      description: "Keyed waitpoint creations rejected because their time budget ran out",
    })
  );

/** Construction is bookkeeping only. No client, connection, timer or listener before first use. */
export function registerWaitpointKeyWriter<T extends object>(
  writer: T,
  url: string,
  createClient: (url: string) => WaitpointKeyTransactionClient
): T {
  const target = new URL(url);
  // Same configured database/role/schema shares admission, including separately wrapped handles.
  const identity = JSON.stringify([
    target.hostname.toLowerCase(),
    target.port || "5432",
    target.pathname,
    target.username,
    target.searchParams.get("schema") ?? "public",
  ]);
  const lane: WaitpointKeyTransactionLane = singleton(
    `waitpointKeyTransactionLane:${identity}`,
    () =>
      new WaitpointKeyTransactionLane(
        () => {
          const isolated = new URL(url);
          isolated.searchParams.set(
            "connection_limit",
            String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE)
          );
          isolated.searchParams.set("pool_timeout", "4");
          isolated.searchParams.set("connect_timeout", "4");
          // Requests can still enter this lane while HTTP drains after a process signal.
          // Keep the isolated client for the process lifetime, like the other DB clients.
          return createClient(isolated.href);
        },
        { recordBudgetExhausted: () => budgetExhaustedCounter().add(1) }
      )
  );
  return registerWaitpointKeyTransactionLane(writer, lane);
}
