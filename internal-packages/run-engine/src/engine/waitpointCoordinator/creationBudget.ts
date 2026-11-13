import { AsyncLocalStorage } from "node:async_hooks";
import type { RedisClient } from "@internal/redis";
import { WaitpointKeyTransactionBudgetExhaustedError } from "@internal/run-store";

type Command = Parameters<RedisClient["sendCommand"]>[0];

// Prisma's existing interactive transaction expires at 5s. Leave time to commit/roll back.
const TRANSACTION_WORK_MS = 4_500;
const budget = new AsyncLocalStorage<{
  deadline: number;
}>();

function creationBudgetRemaining(): number | undefined {
  const until = budget.getStore()?.deadline;
  if (until === undefined) return undefined;
  const remaining = Math.floor(until - performance.now());
  if (remaining <= 0) throw new WaitpointKeyTransactionBudgetExhaustedError();
  return remaining;
}

export function assertCreationBudget(): void {
  creationBudgetRemaining();
}

// Only read-only readiness/policy checks may outlive this wait. Their continuation never
// dispatches a store command: #call checks the budget after this resolves.
export async function prepareWithinCreationBudget(prepare: () => Promise<void>): Promise<void> {
  const remaining = creationBudgetRemaining();
  if (remaining === undefined) return prepare();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prepare(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WaitpointKeyTransactionBudgetExhaustedError()),
          remaining
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function withCreationBudget<T>(acceptUntil: number, work: () => Promise<T>): Promise<T> {
  return budget.run(
    { deadline: performance.now() + Math.min(TRANSACTION_WORK_MS, acceptUntil - Date.now()) },
    work
  );
}

/** Scope timers to this store client. A timeout rejects the caller, but does not cancel
 * Redis execution; the scripts' fixed acceptUntil and claim token fence late publication. */
export function installCreationBudget(client: RedisClient): void {
  const commandDeadlines = new WeakMap<Command, number>();
  const configuredTimeout =
    "redisOptions" in client.options
      ? client.options.redisOptions?.commandTimeout
      : "commandTimeout" in client.options
        ? client.options.commandTimeout
        : undefined;
  const sendCommand = client.sendCommand.bind(client);
  client.sendCommand = (...args: Parameters<RedisClient["sendCommand"]>) => {
    const command = args[0];
    try {
      const until = commandDeadlines.get(command) ?? budget.getStore()?.deadline;
      if (until !== undefined) {
        commandDeadlines.set(command, until);
        const remaining = Math.floor(until - performance.now());
        if (remaining <= 0) throw new WaitpointKeyTransactionBudgetExhaustedError();
        command.setTimeout(
          Math.min(
            configuredTimeout && configuredTimeout > 0 ? configuredTimeout : 2_000,
            2_000,
            remaining
          )
        );
      }
    } catch (error) {
      command.reject(error as Error);
      return command.promise;
    }
    return Reflect.apply(sendCommand, client, args);
  };
}
