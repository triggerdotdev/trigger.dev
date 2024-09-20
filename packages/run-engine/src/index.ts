import { PrismaClient, Prisma } from "@trigger.dev/database";
import { type RedisOptions } from "ioredis";

type Options = {
  prisma: PrismaClient;
  redis: RedisOptions;
  //todo
  // queue: RunQueue;
};

export class RunEngine {
  private prisma: PrismaClient;

  constructor(private readonly options: Options) {
    this.prisma = options.prisma;
  }

  /** Triggers one run.
   *  This doesn't start execution, but it will schedule it for execution.
   */
  async trigger() {
    // const result = await this.options.prisma.taskRun.create({});
    // return result;
  }

  /** Triggers multiple runs.
   * This doesn't start execution, but it will create a batch and schedule them for execution.
   */
  async batchTrigger() {}

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async readyToExecute(runId: string) {}

  /** We want to actually execute the run, this could be a continuation of a previous execution.
   * This is called from the queue, when the run has been pulled. */
  async execute(runId: string) {}
}
