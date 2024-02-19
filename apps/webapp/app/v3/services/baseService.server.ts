import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { attributesFromAuthenticatedEnv, tracer } from "../tracer.server";
import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { Span, SpanKind } from "@opentelemetry/api";

export abstract class BaseService {
  constructor(protected readonly _prisma: PrismaClient = prisma) {}

  protected async traceWithEnv<T>(
    trace: string,
    env: AuthenticatedEnvironment,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return tracer.startActiveSpan(
      `${this.constructor.name}.${trace}`,
      { attributes: attributesFromAuthenticatedEnv(env), kind: SpanKind.SERVER },
      async (span) => {
        try {
          return await fn(span);
        } catch (e) {
          if (e instanceof Error) {
            span.recordException(e);
          } else {
            span.recordException(new Error(String(e)));
          }

          throw e;
        } finally {
          span.end();
        }
      }
    );
  }
}
