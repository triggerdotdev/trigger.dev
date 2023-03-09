import type { ProjectDeployment } from ".prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { taskQueue } from "~/services/messageBroker.server";
import type {
  GetLogsOptions,
  GetLogsResponse,
  LogLine,
} from "../cakework.server";
import { getBuildLogs } from "../cakework.server";
import { getVmLogs } from "../cakework.server";

export class DeploymentLogPoll {
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
      case "ERROR":
      case "CANCELLED": {
        return true;
      }
      case "PENDING":
      case "BUILDING":
      case "DEPLOYING": {
        await this.#pollLogs(deployment, "BUILD");
        await this.#scheduleNextPoll(deployment, "BUILD", count);
        break;
      }
      case "STOPPING":
      case "DEPLOYED": {
        await this.#pollLogs(deployment, "MACHINE");
        await this.#scheduleNextPoll(deployment, "MACHINE", count);

        break;
      }
      default:
        const _exhaustiveCheck: never = deployment.status;
        return _exhaustiveCheck;
    }
  }

  async #scheduleNextPoll(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE",
    count: number
  ) {
    // Find the latest actual log
    const latestLog = await this.#prismaClient.deploymentLog.findFirst({
      where: {
        deploymentId: deployment.id,
        logType,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 1,
    });

    if (!latestLog) {
      console.log(
        `[${logType}] No logs for ${deployment.id} yet. Trying again in 3 seconds.`
      );
      // If there are no logs, schedule again in 3 seconds
      await taskQueue.publish(
        "DEPLOYMENT_LOG_POLL",
        { id: deployment.id, count: count + 1 },
        {},
        { deliverAfter: 3000 }
      );

      return;
    }

    // If there is a log
    if (latestLog) {
      // and it's less than 10 seconds old, schedule again in 3 seconds
      if (latestLog.createdAt.getTime() > Date.now() - 10000) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 10 seconds old. Trying again in 3 seconds.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 3000 }
        );
        return;
      }

      // and it's less than 60 seconds old, schedule again in 5 seconds
      if (latestLog.createdAt.getTime() > Date.now() - 60 * 1000) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 60 seconds old. Trying again in 5 seconds.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 5000 }
        );
        return;
      }

      // and it's less than 5 minutes old, schedule again in 10 seconds
      if (latestLog.createdAt.getTime() > Date.now() - 5 * 60 * 1000) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 5 minutes old. Trying again in 10 seconds.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 10000 }
        );
        return;
      }

      // And it's less than 60 minutes old, schedule again in 30 seconds
      if (latestLog.createdAt.getTime() > Date.now() - 60 * 60 * 1000) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 60 minutes old. Trying again in 30 seconds.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 30000 }
        );
        return;
      }

      // And it's less than 24 hours old, schedule again in 5 minutes
      if (latestLog.createdAt.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 24 hours old. Trying again in 5 minutes.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 5 * 60 * 1000 }
        );
        return;
      }

      // And it's less than 7 days old, schedule again in 30 minutes
      if (
        latestLog.createdAt.getTime() >
        Date.now() - 7 * 24 * 60 * 60 * 1000
      ) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 7 days old. Trying again in 30 minutes.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 30 * 60 * 1000 }
        );
        return;
      }

      // If it's less than 30 days old, schedule again in 2 hours
      if (
        latestLog.createdAt.getTime() >
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ) {
        console.log(
          `[${logType}] Latest log for ${deployment.id} is less than 30 days old. Trying again in 2 hours.`
        );

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 2 * 60 * 60 * 1000 }
        );
        return;
      }

      // Else stop scheduling
      console.log(
        `[${logType}] Latest log for ${deployment.id} is more than 30 days old. Stopping polling.`
      );
    }
  }

  async #pollLogs(deployment: ProjectDeployment, logType: "BUILD" | "MACHINE") {
    const { machineLogLatestLog, buildLogLatestLog } =
      await this.#prismaClient.projectDeployment.findUniqueOrThrow({
        where: {
          id: deployment.id,
        },
        select: {
          machineLogLatestLog: true,
          buildLogLatestLog: true,
        },
      });

    const latestLog =
      logType === "BUILD" ? buildLogLatestLog : machineLogLatestLog;

    let fromDate =
      latestLog ?? deployment.buildFinishedAt ?? new Date(24 * 60 * 60 * 1000);

    // Add 1 millisecond to fromDate to avoid duplicate logs
    fromDate = new Date(fromDate.getTime() + 1);

    const toDate = new Date();

    const logs = await this.#gatherLogs(deployment, logType, fromDate, toDate);

    const filteredLogs = logs.filter((log) => filterLine(log.message));

    // Create a new log for each line
    await this.#prismaClient.deploymentLog.createMany({
      data: filteredLogs.map((log, index) =>
        createLogRecord(deployment.id, index, log, "MACHINE")
      ),
      skipDuplicates: true,
    });

    // Update the machineLogLatestLog
    await this.#prismaClient.projectDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        machineLogLatestLog: toDate,
      },
    });

    return filteredLogs.length;
  }

  async #gatherLogs(
    deployment: ProjectDeployment,
    logType: "BUILD" | "MACHINE",
    fromDate: Date,
    toDate: Date,
    paginationToken?: string,
    logs: LogLine[] = []
  ): Promise<Array<LogLine>> {
    if (!deployment.vmIdentifier) {
      return [];
    }

    const logsResponse = await this.#getLogs(deployment, logType, {
      from: fromDate,
      to: toDate,
      batch: 100,
      pagination: paginationToken,
    });

    if (logsResponse.pagination) {
      return this.#gatherLogs(
        deployment,
        logType,
        fromDate,
        toDate,
        logsResponse.pagination,
        logs.concat(logsResponse.lines)
      );
    }

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
    log: log.message,
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
