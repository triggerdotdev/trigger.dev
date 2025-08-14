import Redis, { RedisOptions } from "ioredis";
import { Prisma, PrismaClientOrTransaction, PrismaTransactionOptions, prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export type AutoIncrementCounterOptions = {
  redis: RedisOptions;
};

export class AutoIncrementCounter {
  private _redis: Redis;

  constructor(private options: AutoIncrementCounterOptions) {
    this._redis = new Redis({
      ...options.redis,
      family: 0, // Support both IPv4 and IPv6 (Railway internal DNS)
    });
  }

  async incrementInTransaction<T>(
    key: string,
    callback: (num: number, tx: PrismaClientOrTransaction) => Promise<T>,
    backfiller?: (key: string, db: PrismaClientOrTransaction) => Promise<number | undefined>,
    client: PrismaClientOrTransaction = prisma,
    transactionOptions?: PrismaTransactionOptions
  ): Promise<T | undefined> {
    let performedIncrement = false;
    let performedBackfill = false;

    try {
      let newNumber = await this.#increment(key);

      performedIncrement = true;

      if (newNumber === 1 && backfiller) {
        const backfilledNumber = await backfiller(key, client);

        if (backfilledNumber && backfilledNumber > 1) {
          newNumber = backfilledNumber + 1;
          await this._redis.set(key, newNumber);
          performedBackfill = true;
        }
      }

      return await callback(newNumber, client);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError ||
        e instanceof Prisma.PrismaClientUnknownRequestError ||
        e instanceof Prisma.PrismaClientValidationError
      ) {
        if (performedIncrement && !performedBackfill) {
          await this._redis.decr(key);
        }
      }

      throw e;
    }
  }

  async #increment(key: string): Promise<number> {
    return await this._redis.incr(key);
  }
}

export const autoIncrementCounter = singleton("auto-increment-counter", getAutoIncrementCounter);

function getAutoIncrementCounter() {
  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    throw new Error(
      "Could not initialize auto-increment counter because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. "
    );
  }

  return new AutoIncrementCounter({
    redis: {
      keyPrefix: "auto-counter:",
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
  });
}
