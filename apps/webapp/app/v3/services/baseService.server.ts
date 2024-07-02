import { Span, SpanKind } from "@opentelemetry/api";
import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { attributesFromAuthenticatedEnv, tracer } from "../tracer.server";

export abstract class BaseService {
  constructor(protected readonly _prisma: PrismaClientOrTransaction = prisma) {}

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
          if (e instanceof ServiceValidationError) {
            throw e;
          }

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

export class ServiceValidationError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ServiceValidationError";
  }
}
