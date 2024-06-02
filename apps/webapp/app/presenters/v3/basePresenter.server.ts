import { Span, SpanKind } from "@opentelemetry/api";
import { $replica, PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { attributesFromAuthenticatedEnv, tracer } from "../../v3/tracer.server";

export abstract class BasePresenter {
  constructor(
    protected readonly _prisma: PrismaClientOrTransaction = prisma,
    protected readonly _replica: PrismaClientOrTransaction = $replica
  ) {}

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

  protected async trace<T>(trace: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
      `${this.constructor.name}.${trace}`,
      { kind: SpanKind.SERVER },
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
