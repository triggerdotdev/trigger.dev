import { type Context, type Span, context, createContextKey, trace } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { PrismaClient } from "@trigger.dev/database";

const DATASOURCE_CONTEXT_KEY = createContextKey("trigger.db.datasource");
const CLIENT_TYPE_CONTEXT_KEY = createContextKey("trigger.db.client_type");

export class DatasourceAttributeSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const ds = parentContext.getValue(DATASOURCE_CONTEXT_KEY);
    if (typeof ds === "string") {
      span.setAttribute("db.datasource", ds);
    }
    const clientType = parentContext.getValue(CLIENT_TYPE_CONTEXT_KEY);
    if (typeof clientType === "string") {
      span.setAttribute("db.client_type", clientType);
    }
  }
  onEnd(): void {}
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export type DatasourceLabel =
  | "control-plane-writer"
  | "control-plane-replica"
  | "legacy-run-ops-writer"
  | "legacy-run-ops-replica"
  | "run-ops-writer"
  | "run-ops-replica"
  | "webhook-writer"
  | "webhook-partitions"
  | "webhook-replica"
  | "alert-partitions";

export function tagDatasource<T extends PrismaClient>(
  datasource: DatasourceLabel,
  clientType: string,
  client: T
): T {
  return client.$extends({
    name: "datasource-tagger",
    query: {
      $allOperations: ({ query, args }) => {
        trace
          .getActiveSpan()
          ?.setAttributes({ "db.datasource": datasource, "db.client_type": clientType });
        return context.with(
          context
            .active()
            .setValue(DATASOURCE_CONTEXT_KEY, datasource)
            .setValue(CLIENT_TYPE_CONTEXT_KEY, clientType),
          async () => await query(args)
        );
      },
    },
  }) as unknown as T;
}

// Same extension as tagDatasource but typed for RunOpsPrismaClient (different
// generated package — does not extend @trigger.dev/database.PrismaClient).
export function tagDatasourceRunOps(
  datasource: DatasourceLabel,
  clientType: string,
  client: RunOpsPrismaClient
): RunOpsPrismaClient {
  return client.$extends({
    name: "datasource-tagger",
    query: {
      $allOperations: ({ query, args }) => {
        trace
          .getActiveSpan()
          ?.setAttributes({ "db.datasource": datasource, "db.client_type": clientType });
        return context.with(
          context
            .active()
            .setValue(DATASOURCE_CONTEXT_KEY, datasource)
            .setValue(CLIENT_TYPE_CONTEXT_KEY, clientType),
          async () => await query(args)
        );
      },
    },
  }) as unknown as RunOpsPrismaClient;
}
