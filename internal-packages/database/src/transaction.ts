import { Prisma, PrismaClient } from "@prisma/client";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PrismaClientOrTransaction = PrismaClient | PrismaTransactionClient;

export type PrismaReplicaClient = Omit<PrismaClient, "$transaction">;

export const Decimal = Prisma.Decimal;

function isTransactionClient(prisma: PrismaClientOrTransaction): prisma is PrismaTransactionClient {
  return !("$transaction" in prisma);
}

export function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

/*
•	P2024: Connection timeout errors
•	P2028: Transaction timeout errors
•	P2034: Transaction deadlock/conflict errors
*/
const retryCodes = ["P2024", "P2028", "P2034"];

export function isPrismaRetriableError(error: unknown): boolean {
  if (!isPrismaKnownError(error)) {
    return false;
  }

  return retryCodes.includes(error.code);
}

/*
•	P2025: Record not found errors (in race conditions) [not included for now]
*/
export function isPrismaRaceConditionError(error: unknown): boolean {
  if (!isPrismaKnownError(error)) {
    return false;
  }

  return error.code === "P2025";
}

export type PrismaTransactionOptions = {
  /** The maximum amount of time (in ms) Prisma Client will wait to acquire a transaction from the database. The default value is 2000ms. */
  maxWait?: number;

  /** The maximum amount of time (in ms) the interactive transaction can run before being canceled and rolled back. The default value is 5000ms. */
  timeout?: number;

  /**  Sets the transaction isolation level. By default this is set to the value currently configured in your database. */
  isolationLevel?: Prisma.TransactionIsolationLevel;

  swallowPrismaErrors?: boolean;

  /**
   * The maximum number of times the transaction will be retried in case of a serialization failure. The default value is 0.
   *
   * See https://www.prisma.io/docs/orm/prisma-client/queries/transactions#transaction-timing-issues
   */
  maxRetries?: number;
};

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  prismaError: (error: Prisma.PrismaClientKnownRequestError) => void,
  options?: PrismaTransactionOptions,
  attempt = 0
): Promise<R | undefined> {
  if (isTransactionClient(prisma)) {
    return fn(prisma);
  }

  try {
    return await (prisma as PrismaClient).$transaction(fn, options);
  } catch (error) {
    if (isPrismaKnownError(error)) {
      if (
        retryCodes.includes(error.code) &&
        typeof options?.maxRetries === "number" &&
        attempt < options.maxRetries
      ) {
        return $transaction(prisma, fn, prismaError, options, attempt + 1);
      }

      prismaError(error);

      if (options?.swallowPrismaErrors) {
        return;
      }
    }

    throw error;
  }
}

export function isUniqueConstraintError<T extends readonly string[]>(
  error: unknown,
  columns: T
): boolean {
  if (!isPrismaKnownError(error)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;

  if (!Array.isArray(target)) {
    return false;
  }

  if (target.length !== columns.length) {
    return false;
  }

  for (let i = 0; i < columns.length; i++) {
    if (target[i] !== columns[i]) {
      return false;
    }
  }

  return true;
}
