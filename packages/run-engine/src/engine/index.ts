import { PrismaClient, Prisma } from "@trigger.dev/database";
import { Redis, type RedisOptions } from "ioredis";
import Redlock from "redlock";

type Options = {
  prisma: PrismaClient;
  redis: RedisOptions;
  //todo
  // queue: RunQueue;
};

export class RunEngine {
  private prisma: PrismaClient;
  private redis: Redis;
  private redlock: Redlock;

  constructor(private readonly options: Options) {
    this.prisma = options.prisma;
    this.redis = new Redis(options.redis);
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200, // time in ms
      retryJitter: 200, // time in ms
      automaticExtensionThreshold: 500, // time in ms
    });
  }

  /** "Triggers" one run, which creates the run
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
  async prepareForQueue(runId: string) {}

  /** We want to actually execute the run, this could be a continuation of a previous execution.
   * This is called from the queue, when the run has been pulled. */
  //todo think more about this, when do we create the attempt?
  //todo what does this actually do?
  //todo how does it get sent to the worker? DEV and PROD
  async prepareForExecution(runId: string) {}

  async prepareForAttempt(runId: string) {}

  async complete(runId: string, completion: any) {}
}

/* 
Starting execution flow:

1. Run id is pulled from a queue
2. Prepare the run for an attempt (returns data to send to the worker)
  a. The run is marked as "waiting to start"?
  b. Create a TaskRunState with the run id, and the state "waiting to start".
  c. Start a heartbeat with the TaskRunState id, in case it never starts.
3. The run is sent to the worker
4. When the worker has received the run, it ask the platform for an attempt
5. The attempt is created
  a. The attempt is created
  b. The TaskRunState is updated to "EXECUTING"
  c. Start a heartbeat with the TaskRunState id.
  c. The TaskRun is updated to "EXECUTING"
6. A response is sent back to the worker with the attempt data
7. The code executes...
*/
