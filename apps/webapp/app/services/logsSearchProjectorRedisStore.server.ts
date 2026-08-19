import type { RedisClient } from "~/redis.server";
import type {
  LogsSearchProjectionMode,
  LogsSearchProjectorLeaseStatus,
  LogsSearchProjectorRedisStore,
} from "~/services/logsSearchProjector.server";

const LEASE_KEY = "logs-search-projector:coordination:lease";
const PREVIEW_WATERMARK_KEY = "logs-search-projector:coordination:preview-watermark";

const releaseLeaseScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const advanceWatermarkScript = `
  local current = redis.call("GET", KEYS[1])
  if not current or tonumber(ARGV[1]) > tonumber(current) then
    redis.call("SET", KEYS[1], ARGV[1])
    return 1
  end
  return 0
`;

type LeaseValue = {
  token: string;
  mode: LogsSearchProjectionMode;
};

export class RedisLogsSearchProjectorStore implements LogsSearchProjectorRedisStore {
  constructor(private readonly redis: RedisClient) {}

  async acquireLease(
    token: string,
    mode: LogsSearchProjectionMode,
    durationMs: number
  ): Promise<boolean> {
    const result = await this.redis.set(
      LEASE_KEY,
      serializeLease({ token, mode }),
      "PX",
      durationMs,
      "NX"
    );
    return result === "OK";
  }

  async releaseLease(token: string, mode: LogsSearchProjectionMode): Promise<void> {
    await this.redis.eval(releaseLeaseScript, 1, LEASE_KEY, serializeLease({ token, mode }));
  }

  async readLeaseStatus(): Promise<LogsSearchProjectorLeaseStatus | null> {
    const [value, ttlMs] = await Promise.all([
      this.redis.get(LEASE_KEY),
      this.redis.pttl(LEASE_KEY),
    ]);
    if (!value || ttlMs < 0) return null;

    const lease = parseLease(value);
    if (!lease) return null;
    return { mode: lease.mode, expiresAt: new Date(Date.now() + ttlMs) };
  }

  async initializePreviewWatermark(boundary: Date): Promise<Date> {
    await this.redis.set(PREVIEW_WATERMARK_KEY, boundary.getTime().toString(), "NX");
    const watermark = await this.getPreviewWatermark();
    if (!watermark) throw new Error("Failed to initialize logs search preview watermark");
    return watermark;
  }

  async getPreviewWatermark(): Promise<Date | null> {
    const value = await this.redis.get(PREVIEW_WATERMARK_KEY);
    if (value === null) return null;

    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) {
      throw new Error("Logs search preview watermark is invalid");
    }
    return new Date(timestamp);
  }

  async advancePreviewWatermark(next: Date): Promise<boolean> {
    const result = await this.redis.eval(
      advanceWatermarkScript,
      1,
      PREVIEW_WATERMARK_KEY,
      next.getTime().toString()
    );
    return Number(result) === 1;
  }
}

function serializeLease(value: LeaseValue): string {
  return JSON.stringify(value);
}

function parseLease(value: string): LeaseValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<LeaseValue>;
    if (
      typeof parsed.token !== "string" ||
      (parsed.mode !== "preview" && parsed.mode !== "finalized")
    ) {
      return null;
    }
    return { token: parsed.token, mode: parsed.mode };
  } catch {
    return null;
  }
}
