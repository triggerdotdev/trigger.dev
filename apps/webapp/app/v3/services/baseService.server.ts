import { Span, SpanKind } from "@opentelemetry/api";
import { $replica, PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { attributesFromAuthenticatedEnv, tracer } from "../tracer.server";
import { engine, RunEngine } from "../runEngine.server";
import { ServiceValidationError } from "./common.server";

export { ServiceValidationError };

export abstract class BaseService {
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

export type WithRunEngineOptions<T> = T & {
  prisma?: PrismaClientOrTransaction;
  engine?: RunEngine;
};

export class WithRunEngine extends BaseService {
  protected readonly _engine: RunEngine;

  constructor(opts: { prisma?: PrismaClientOrTransaction; engine?: RunEngine } = {}) {
    super(opts.prisma);
    this._engine = opts.engine ?? engine;
  }
}
