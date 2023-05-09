import type { DeploymentLogPoll, ProjectDeployment } from ".prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type {
  GetLogsOptions,
  GetLogsResponse,
  LogLine,
} from "../cakework.server";
import { getBuildLogs, getVmLogs } from "../cakework.server";

export class PollDeploymentLogs {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string, count: number) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        id,
      },
      include: {
        project: true,
      },
    });

    if (!deployment) {
      return true;
    }

    switch (deployment.status) {
      case "STOPPED":
      case "CANCELLED": {
        return true;
      }
      case "ERROR":
      case "PENDING":
      case "BUILDING":
      case "DEPLOYING": {
        const poll = await this.#pollLogs(deployment, "BUILD", count);
        await this.#scheduleNextPoll(deployment, poll, count);
        break;
      }
      case "STOPPING":
      case "DEPLOYED": {
        const poll = await this.#pollLogs(deployment, "MACHINE", count);
        await this.#scheduleNextPoll(deployment, poll, count);

        break;
      }
      default:
        const _exhaustiveCheck: never = deployment.status;
        return _exhaustiveCheck;
    }
  }

  async #scheduleNextPoll(
    deployment: ProjectDeployment,
    poll: DeploymentLogPoll,
    count: number = 0
  ) {
    if (!poll.nextPollScheduledAt) {
      return;
    }

    // TODO: implement this
    // await taskQueue.publish(
    //   "DEPLOYMENT_LOG_POLL",
    //   { id: deployment.id, count: poll.pollNumber },
    //   {},
    //   { deliverAt: poll.nextPollScheduledAt.getTime() }
    // );
  }

  async #calculateNextPollScheduledAt(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE"
  ): Promise<Date | undefined> {
    const lastLog = await this.#prismaClient.deploymentLog.findFirst({
      where: {
        deploymentId: deployment.id,
        logType,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const latestLogAt = lastLog?.createdAt;

    if (!latestLogAt) {
      return new Date(Date.now() + 3000);
    }

    // and it's less than 10 seconds old, schedule again in 3 seconds
    if (latestLogAt.getTime() > Date.now() - 10000) {
      return new Date(Date.now() + 3000);
    }

    // and it's less than 60 seconds old, schedule again in 5 seconds
    if (latestLogAt.getTime() > Date.now() - 60 * 1000) {
      return new Date(Date.now() + 5000);
    }

    // and it's less than 5 minutes old, schedule again in 10 seconds
    if (latestLogAt.getTime() > Date.now() - 5 * 60 * 1000) {
      return new Date(Date.now() + 10000);
    }

    // And it's less than 15 minutes old, schedule again in 15 seconds
    if (latestLogAt.getTime() > Date.now() - 15 * 60 * 1000) {
      return new Date(Date.now() + 15000);
    }

    // If this is a BUILD log poll, then we're going to just stop polling now (builds don't take that long)
    if (logType === "BUILD") {
      return;
    }

    // And it's less than 20 minutes old, schedule again in 20 seconds
    if (latestLogAt.getTime() > Date.now() - 20 * 60 * 1000) {
      return new Date(Date.now() + 20000);
    }

    // And it's less than 60 minutes old, schedule again in 30 seconds
    if (latestLogAt.getTime() > Date.now() - 60 * 60 * 1000) {
      return new Date(Date.now() + 30000);
    }

    // And it's less than 24 hours old, schedule again in 5 minutes
    if (latestLogAt.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
      return new Date(Date.now() + 5 * 60 * 1000);
    }

    // And it's less than 7 days old, schedule again in 30 minutes
    if (latestLogAt.getTime() > Date.now() - 7 * 24 * 60 * 60 * 1000) {
      return new Date(Date.now() + 30 * 60 * 1000);
    }

    // If it's less than 30 days old, schedule again in 2 hours
    if (latestLogAt.getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000) {
      return new Date(Date.now() + 2 * 60 * 60 * 1000);
    }

    // Else stop scheduling
  }

  async #pollLogs(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE",
    pollNumber: number
  ) {
    const latestPoll = await this.#prismaClient.deploymentLogPoll.findFirst({
      where: {
        deploymentId: deployment.id,
        logType,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // or start from 24 hours ago
    let fromDate =
      latestPoll?.to ??
      deployment.buildFinishedAt ??
      new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    // Add 1 millisecond to fromDate to avoid duplicate logs
    fromDate = new Date(fromDate.getTime() + 1);

    const toDate = new Date();

    const logs = await this.#gatherLogs(deployment, logType, fromDate, toDate);

    const filteredLogs = logs.filter((log) => filterLine(log.message));

    // Create a new log for each line
    await this.#prismaClient.deploymentLog.createMany({
      data: filteredLogs.map((log, index) =>
        createLogRecord(deployment.id, index, log, logType)
      ),
      skipDuplicates: true,
    });

    const latestFilteredLog = filteredLogs[filteredLogs.length - 1];

    return await this.#prismaClient.deploymentLogPoll.create({
      data: {
        deployment: {
          connect: {
            id: deployment.id,
          },
        },
        logType,
        from: fromDate,
        to: toDate,
        totalLogsCount: logs.length,
        filteredLogsCount: filteredLogs.length,
        nextPollScheduledAt: await this.#calculateNextPollScheduledAt(
          deployment,
          logType
        ),
        pollNumber: pollNumber + 1,
      },
    });
  }

  async #gatherLogs(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE",
    fromDate: Date,
    toDate: Date,
    paginationToken?: string,
    logs: LogLine[] = []
  ): Promise<Array<LogLine>> {
    const logsResponse = await this.#getLogs(deployment, logType, {
      from: fromDate,
      to: toDate,
      batch: 100,
      pagination: paginationToken,
    });

    // if (logsResponse.pagination) {
    //   return this.#gatherLogs(
    //     deployment,
    //     logType,
    //     fromDate,
    //     toDate,
    //     logsResponse.pagination,
    //     logs.concat(logsResponse.lines)
    //   );
    // }

    return logs.concat(logsResponse.lines);
  }

  async #getLogs(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE",
    options: GetLogsOptions = {}
  ): Promise<GetLogsResponse> {
    switch (logType) {
      case "BUILD":
        return getBuildLogs(deployment.buildId, options);
      case "MACHINE":
        if (!deployment.vmIdentifier) {
          return { lines: [] };
        }

        return getVmLogs(deployment.vmIdentifier, options);
      default:
        throw new Error(`Unknown log type: ${logType}`);
    }
  }
}

function createLogRecord(
  deploymentId: string,
  logNumber: number,
  log: LogLine,
  logType: "BUILD" | "MACHINE"
) {
  const id = createHashFromArgs(
    deploymentId,
    String(log.timestamp),
    log.message
  );

  return {
    id,
    deploymentId,
    logNumber,
    logType,
    log: log.message.trim(),
    level: log.level,
    createdAt: new Date(log.timestamp),
  };
}

function createHashFromArgs(...args: string[]): string {
  return createHash("md5").update(args.join("")).digest("hex");
}

// Lines to filter out:
// waiting for machine to listen on 0.0.0.0:8080 (waited 5.626604s so far)"
// "Configuring firecracker"
// failed to connect to machine: gave up after 50 attempts (in 44.532756592s)
// "Starting machine"
// failed to connect to instance after 6 attempts
// Failed to proxy HTTP request (error: could not find an instance to route to). Retrying in 1000 ms (attempt 10)
// machines API returned an error
function filterLine(message: string) {
  const regexes = [
    /waiting for machine to listen on/,
    /Configuring firecracker/,
    /failed to connect to machine/,
    /Starting machine/,
    /failed to connect to instance/,
    /Failed to proxy HTTP request/,
    /machines API returned an error/,
  ];

  return !regexes.some((regex) => regex.test(message));
}
