import { Prisma, PrismaClient } from "@prisma/client";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PrismaClientOrTransaction = PrismaClient | PrismaTransactionClient;

export type PrismaReplicaClient = Omit<PrismaClient, "$transaction">;

function isTransactionClient(prisma: PrismaClientOrTransaction): prisma is PrismaTransactionClient {
  return !("$transaction" in prisma);
}

function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

export type PrismaTransactionOptions = {
  /** The maximum amount of time (in ms) Prisma Client will wait to acquire a transaction from the database. The default value is 2000ms. */
  maxWait?: number;

  /** The maximum amount of time (in ms) the interactive transaction can run before being canceled and rolled back. The default value is 5000ms. */
  timeout?: number;

  /**  Sets the transaction isolation level. By default this is set to the value currently configured in your database. */
  isolationLevel?: Prisma.TransactionIsolationLevel;

  swallowPrismaErrors?: boolean;
};

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  prismaError: (error: Prisma.PrismaClientKnownRequestError) => void,
  options?: PrismaTransactionOptions
): Promise<R | undefined> {
  if (isTransactionClient(prisma)) {
    return fn(prisma);
  }

  try {
    return await (prisma as PrismaClient).$transaction(fn, options);
  } catch (error) {
    if (isPrismaKnownError(error)) {
      prismaError(error);

      if (options?.swallowPrismaErrors) {
        return;
      }
    }

    throw error;
  }
}
