import { CacheService } from "core/cache/types";
import { prisma } from "../db/db.server";

export class PostgresCacheService implements CacheService {
  constructor(private readonly namespace: string) {}

  async get(key: string) {
    const cachedRow = await prisma.cache.findFirst({
      where: {
        namespace: this.namespace,
        key,
        OR: [
          { expiresAt: null },
          {
            expiresAt: {
              gt: new Date(),
            },
          },
        ],
      },
    });

    if (cachedRow) {
      return cachedRow.value;
    }

    return null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;

    await prisma.cache.upsert({
      where: {
        namespace_key: {
          namespace: this.namespace,
          key,
        },
      },
      update: {
        value,
        expiresAt,
      },
      create: {
        namespace: this.namespace,
        key,
        value,
        expiresAt,
      },
    });
  }
}
