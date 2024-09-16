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

  /** Creates a new run with the options, returns metadata */
  async trigger() {
    // const result = await this.options.prisma.taskRun.create({});
    // return result;
  }

  async execute(runId: string) {}
}
