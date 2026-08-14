import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LogsSearchProjectorConflictError,
  LogsSearchProjectorValidationError,
} from "~/services/logsSearchProjector.server";

const mocks = vi.hoisted(() => ({
  requireAdminApiRequest: vi.fn(),
  status: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancelBackfill: vi.fn(),
  startBackfill: vi.fn(),
}));

vi.mock("~/services/personalAccessToken.server", () => ({
  requireAdminApiRequest: mocks.requireAdminApiRequest,
}));
vi.mock("~/services/logsSearchProjectorInstance.server", () => ({
  getLogsSearchProjector: () => ({
    status: mocks.status,
    pause: mocks.pause,
    resume: mocks.resume,
    cancelBackfill: mocks.cancelBackfill,
    startBackfill: mocks.startBackfill,
  }),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn() },
}));

const route = await import("~/routes/admin.api.v1.logs-search-projector");
const status = { paused: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminApiRequest.mockResolvedValue({ id: "user_123" });
  mocks.status.mockResolvedValue(status);
  mocks.pause.mockResolvedValue(status);
  mocks.resume.mockResolvedValue(status);
  mocks.cancelBackfill.mockResolvedValue(status);
  mocks.startBackfill.mockResolvedValue(status);
});

describe("logs search projector admin route", () => {
  it("requires admin authentication before reading status", async () => {
    const request = new Request("http://localhost/admin/api/v1/logs-search-projector");
    const response = await route.loader({ request, params: {}, context: {} });

    expect(mocks.requireAdminApiRequest).toHaveBeenCalledWith(request);
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual(status);
  });

  it("passes minute-aligned backfill bounds to the projector", async () => {
    const request = new Request("http://localhost/admin/api/v1/logs-search-projector", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "startBackfill",
        from: "2026-08-14T10:00:00.000Z",
        to: "2026-08-14T11:00:00.000Z",
      }),
    });
    const response = await route.action({ request, params: {}, context: {} });

    expect(response.status).toBe(200);
    expect(mocks.startBackfill).toHaveBeenCalledWith({
      action: "startBackfill",
      from: new Date("2026-08-14T10:00:00.000Z"),
      to: new Date("2026-08-14T11:00:00.000Z"),
    });
  });

  it("returns conflict and validation statuses from projector controls", async () => {
    mocks.pause.mockRejectedValueOnce(new LogsSearchProjectorConflictError("busy"));
    let response = await route.action({
      request: new Request("http://localhost/admin/api/v1/logs-search-projector", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      }),
      params: {},
      context: {},
    });
    expect(response.status).toBe(409);

    mocks.resume.mockRejectedValueOnce(new LogsSearchProjectorValidationError("invalid"));
    response = await route.action({
      request: new Request("http://localhost/admin/api/v1/logs-search-projector", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      }),
      params: {},
      context: {},
    });
    expect(response.status).toBe(400);
  });
});
