import { createAsyncIterableStreamFromAsyncIterable } from "@trigger.dev/core/v3";
import { Readable } from "node:stream";
import type { ClientConfig } from "pg";
import { LogicalReplicationClient, LogicalReplicationClientOptions } from "./client.js";
import type { MessageDelete, MessageInsert, MessageUpdate, PgoutputMessage } from "./pgoutput.js";

export interface LogicalReplicationStreamOptions extends LogicalReplicationClientOptions {
  onError?: (err: Error) => void;
  filterTags?: Array<"insert" | "update" | "delete">;
  abortSignal?: AbortSignal;
  highWaterMark?: number;
}

export interface TransactionEvent<T = any> {
  tag: "insert" | "update" | "delete";
  data: T;
  raw: MessageInsert | MessageUpdate | MessageDelete;
}

export interface Transaction<T = any> {
  commitLsn: string | null;
  commitEndLsn: string | null;
  xid: number;
  events: TransactionEvent<T>[];
  replicationLagMs: number;
}

export function createLogicalReplicationStream<T>(
  client: LogicalReplicationClient,
  highWaterMark?: number,
  signal?: AbortSignal
) {
  let lastLsn: string | null = null;
  let isSubscribed = false;

  const source = new ReadableStream<{ lsn: string; message: PgoutputMessage }>(
    {
      async start(controller) {
        console.log("ReadableStream.start");

        if (signal) {
          signal.addEventListener("abort", () => {
            controller.close();
          });
        }

        client.events.on("data", async ({ lsn, log }) => {
          console.log("ReadableStream.data");
          lastLsn = lsn;

          if (signal?.aborted) {
            return;
          }

          if (isRelevantTag(log.tag)) {
            controller.enqueue({ lsn, message: log });
          }

          if (typeof controller.desiredSize === "number" && controller.desiredSize <= 0) {
            await client.stop();
          }
        });
      },
      async cancel() {
        console.log("ReadableStream.cancel");
        await client.stop();
      },
      async pull() {
        if (!isSubscribed) {
          isSubscribed = true;
          console.log("ReadableStream.pull");
          await client.subscribe(lastLsn ?? undefined);
        }
      },
    },
    new CountQueuingStrategy({ highWaterMark: highWaterMark ?? 1 })
  );

  return createAsyncIterableStreamFromAsyncIterable<Transaction<T>>(groupByTransaction(source));
}

export async function* groupByTransaction<T = any>(
  stream: ReadableStream<{
    lsn: string;
    message: PgoutputMessage;
  }>
) {
  let currentTransaction: Omit<Transaction<T>, "commitEndLsn" | "replicationLagMs"> & {
    commitEndLsn?: string | null;
    replicationLagMs?: number;
  } = {
    commitLsn: null,
    xid: 0,
    events: [],
  };
  for await (const { lsn, message } of stream as AsyncIterable<{
    lsn: string;
    message: PgoutputMessage;
  }>) {
    console.log("groupByTransaction.for await");
    console.log(message);
    switch (message.tag) {
      case "begin": {
        currentTransaction = {
          commitLsn: message.commitLsn,
          xid: message.xid,
          events: [],
        };
        break;
      }
      case "insert": {
        currentTransaction.events.push({
          tag: message.tag,
          data: message.new as T,
          raw: message,
        });
        break;
      }
      case "update": {
        currentTransaction.events.push({
          tag: message.tag,
          data: message.new as T,
          raw: message,
        });
        break;
      }
      case "delete": {
        currentTransaction.events.push({
          tag: message.tag,
          data: message.old as T,
          raw: message,
        });
        break;
      }
      case "commit": {
        const replicationLagMs = Date.now() - Number(message.commitTime / 1000n);
        currentTransaction.commitEndLsn = message.commitEndLsn;
        currentTransaction.replicationLagMs = replicationLagMs;
        yield currentTransaction as Transaction<T>;
        break;
      }
    }
  }
}

export function createSubscription<T = any>(opts: LogicalReplicationStreamOptions) {
  const client = new LogicalReplicationClient({
    name: opts.name,
    publicationName: opts.publicationName,
    slotName: opts.slotName,
    pgConfig: opts.pgConfig,
    table: opts.table,
    redisOptions: opts.redisOptions,
    publicationActions: opts.filterTags,
  });

  client.events.on("error", (err) => {
    if (opts.onError) opts.onError(err);
  });

  client.events.on("heartbeat", async ({ lsn, shouldRespond }) => {
    if (shouldRespond) {
      await client.acknowledge(lsn);
    }
  });

  const stream = createLogicalReplicationStream<T>(client, opts.highWaterMark, opts.abortSignal);

  return {
    stream,
    client,
  };
}

function isRelevantTag(tag: string): tag is "insert" | "update" | "delete" | "begin" | "commit" {
  return (
    tag === "insert" || tag === "update" || tag === "delete" || tag === "begin" || tag === "commit"
  );
}
