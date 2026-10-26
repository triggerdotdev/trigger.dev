import type { PrismaClientOrTransaction } from "~/db.server";
import {
  type DeliveryRetryCap,
  EXPIRE_ALERTS_BATCH,
  expireAlerts,
  failExhaustedDeliveries,
  findStalePendingDeliveries,
} from "../storage/alertStore.server";

async function defaultEnqueueDelivery(params: { eventId: string; eventAt: Date }): Promise<void> {
  const { enqueueAlertEventDelivery } =
    await import("../delivery/enqueueAlertEventDelivery.server");
  return enqueueAlertEventDelivery(params);
}

const STALE_DELIVERY_MINUTES = 2;
const STALE_DELIVERY_SWEEP_LIMIT = 50;
const DEFAULT_RETRY_CAP: DeliveryRetryCap = { maxAttempts: 8, maxAgeMs: 24 * 60 * 60 * 1000 };

interface Span {
  setAttributes(attrs: Record<string, unknown>): void;
  recordException(err: Error): void;
  end(): void;
}

export interface AlertsHousekeepingDeps {
  db: PrismaClientOrTransaction;
  enqueueDelivery?: (params: { eventId: string; eventAt: Date }) => Promise<void>;
  retryCap?: DeliveryRetryCap;
  logger?: {
    debug: (message: string, ...args: any[]) => void;
    info: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
  };
  startSpan?: (
    name: string,
    fn: (span: Span) => Promise<AlertsHousekeepingResult>
  ) => Promise<AlertsHousekeepingResult>;
}

export interface AlertsHousekeepingResult {
  expired: number;
  sweeperRequeues: number;
  exhaustedDeliveries: number;
}

const noopSpan: Span = { setAttributes() {}, recordException() {}, end() {} };
const defaultStartSpan = <T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> =>
  fn(noopSpan);

export async function runAlertsHousekeeping(
  params: { now: Date },
  deps: AlertsHousekeepingDeps
): Promise<AlertsHousekeepingResult> {
  const startSpan = deps.startSpan ?? defaultStartSpan;

  return startSpan("alerts.housekeeping", async (span) => {
    const result: AlertsHousekeepingResult = {
      expired: 0,
      sweeperRequeues: 0,
      exhaustedDeliveries: 0,
    };

    try {
      const expiredAlerts = await expireAlerts(deps.db, params.now, { limit: EXPIRE_ALERTS_BATCH });
      result.expired = expiredAlerts.length;

      const doEnqueue = deps.enqueueDelivery ?? defaultEnqueueDelivery;

      const staleBefore = new Date(params.now.getTime() - STALE_DELIVERY_MINUTES * 60_000);
      const staleClaimBefore = new Date(params.now.getTime() - 5 * 60_000);
      const sweep = {
        olderThan: staleBefore,
        staleClaimBefore,
        cap: deps.retryCap ?? DEFAULT_RETRY_CAP,
        now: params.now,
      };
      result.exhaustedDeliveries = await failExhaustedDeliveries(deps.db, sweep);
      const staleDeliveries = await findStalePendingDeliveries(deps.db, {
        ...sweep,
        limit: STALE_DELIVERY_SWEEP_LIMIT,
      });

      for (const delivery of staleDeliveries) {
        try {
          await doEnqueue({ eventId: delivery.alertEventId, eventAt: delivery.eventAt });
          result.sweeperRequeues++;
        } catch (err) {
          deps.logger?.error("sweep re-enqueue failed", {
            deliveryId: delivery.id,
            error: err,
          });
        }
      }

      span.setAttributes({
        "alerts.expired": result.expired,
        "alerts.sweeperRequeues": result.sweeperRequeues,
        "alerts.exhaustedDeliveries": result.exhaustedDeliveries,
      });

      if (result.expired > 0 || result.sweeperRequeues > 0 || result.exhaustedDeliveries > 0) {
        deps.logger?.debug("alerts.housekeeping", { ...result });
      }
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }

    return result;
  });
}
