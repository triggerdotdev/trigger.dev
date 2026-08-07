import { PrismaClient, Prisma } from "@trigger.dev/database";
import { PrismaPg } from "@prisma/adapter-pg";

export type ClientPair = {
  rust: PrismaClient;
  adapter: PrismaClient;
  disconnect: () => Promise<void>;
};

export function createRustClient(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

export function createAdapterClient(url: string, schema?: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url }, schema ? { schema } : undefined);
  return new PrismaClient({ adapter } as unknown as ConstructorParameters<typeof PrismaClient>[0]);
}

export async function createClientPair(url: string): Promise<ClientPair> {
  const rust = createRustClient(url);
  const adapter = createAdapterClient(url);
  return {
    rust,
    adapter,
    disconnect: async () => {
      await Promise.allSettled([rust.$disconnect(), adapter.$disconnect()]);
    },
  };
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint(${value.toString()})`;
  if (Prisma.Decimal.isDecimal(value)) return `Decimal(${(value as Prisma.Decimal).toString()})`;
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (Buffer.isBuffer(value)) return `Buffer(${value.toString("hex")})`;
  if (Array.isArray(value)) return `[${value.map(describe).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${describe(v)}`)
      .join(", ");
    return `{${entries}}`;
  }
  if (typeof value === "string") return `"${value}"`;
  return `${typeof value}(${String(value)})`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return describe(a) === describe(b);
}

export type ShapeCase = {
  id: number;
  name: string;
  callSite: string;
  upstream?: string;
  setup?: (rust: PrismaClient) => Promise<void>;
  run: (client: PrismaClient) => Promise<unknown>;
};

export type ShapeResult = {
  id: number;
  name: string;
  callSite: string;
  upstream?: string;
  rust: string;
  adapter: string;
  identical: boolean;
  adapterErrored: boolean;
};

async function capture(fn: () => Promise<unknown>): Promise<{ desc: string; errored: boolean }> {
  try {
    const value = await fn();
    return { desc: describe(value), errored: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { desc: `ERROR: ${message.split("\n")[0]}`, errored: true };
  }
}

export async function runShape(pair: ClientPair, shape: ShapeCase): Promise<ShapeResult> {
  if (shape.setup) {
    await shape.setup(pair.rust);
  }
  const rust = await capture(() => shape.run(pair.rust));
  const adapter = await capture(() => shape.run(pair.adapter));
  return {
    id: shape.id,
    name: shape.name,
    callSite: shape.callSite,
    upstream: shape.upstream,
    rust: rust.desc,
    adapter: adapter.desc,
    identical: rust.desc === adapter.desc,
    adapterErrored: adapter.errored,
  };
}
