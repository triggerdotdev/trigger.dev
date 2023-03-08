import type { ProjectDeployment } from ".prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { taskQueue } from "~/services/messageBroker.server";
import type { LogLine } from "../cakework.server";
import { getBuildLogs, getVmLogs } from "../cakework.server";

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
      case "STOPPING":
      case "ERROR":
      case "CANCELLED": {
        return true;
      }
      case "PENDING":
      case "BUILDING":
      case "DEPLOYING": {
        // Turning off build logs for now
        // const newLogCount = await this.#pollBuildLogs(deployment);

        // If count === 720, we've been polling for 1 hour

        if (count === 720) {
          // Stop polling after 1 hour
          return true;
        }

        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id, count: count + 1 },
          {},
          { deliverAfter: 5000 }
        );
        break;
      }
      case "DEPLOYED": {
        await this.#pollMachineLogs(deployment);
        await this.#scheduleNextPoll(deployment, count);

        break;
      }
      default:
        const _exhaustiveCheck: never = deployment.status;
        return _exhaustiveCheck;
    }
  }

  async #scheduleNextPoll(deployment: ProjectDeployment, count: number) {
    // Find the latest log
    const latestLog = await this.#prismaClient.deploymentLog.findFirst({
      where: {
        deploymentId: deployment.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 1,
    });

    if (!latestLog) {
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
        await taskQueue.publish(
          "DEPLOYMENT_LOG_POLL",
          { id: deployment.id, count: count + 1 },
          {},
          { deliverAfter: 2 * 60 * 60 * 1000 }
        );
        return;
      }

      // Else stop scheduling
    }
  }

  async #pollBuildLogs(deployment: ProjectDeployment) {
    const latestBuildLog = await this.#prismaClient.deploymentLog.findFirst({
      where: {
        deploymentId: deployment.id,
        logType: "BUILD",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const fromDate =
      latestBuildLog?.createdAt ??
      deployment.buildStartedAt ??
      new Date(24 * 60 * 60 * 1000);

    const toDate = new Date();

    const logs = await this.#gatherBuildLogs(deployment, fromDate, toDate);

    const filteredLogs = logs.filter((log) => filterLine(log.message));

    // Create a new log for each line
    await this.#prismaClient.deploymentLog.createMany({
      data: filteredLogs.map((log, index) =>
        createLogRecord(deployment.id, index, log, "BUILD")
      ),
      skipDuplicates: true,
    });

    return filteredLogs.length;
  }

  async #gatherBuildLogs(
    deployment: ProjectDeployment,
    fromDate: Date,
    toDate: Date,
    paginationToken?: string,
    logs: LogLine[] = []
  ): Promise<Array<LogLine>> {
    const logsResponse = await getBuildLogs(deployment.buildId, {
      from: fromDate,
      to: toDate,
      batch: 100,
      pagination: paginationToken,
    });

    if (logsResponse.pagination) {
      return this.#gatherBuildLogs(
        deployment,
        fromDate,
        toDate,
        logsResponse.pagination,
        logs.concat(logsResponse.lines)
      );
    }

    return logs.concat(logsResponse.lines);
  }

  async #pollMachineLogs(deployment: ProjectDeployment) {
    const latestBuildLog = await this.#prismaClient.deploymentLog.findFirst({
      where: {
        deploymentId: deployment.id,
        logType: "MACHINE",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    let fromDate =
      latestBuildLog?.createdAt ??
      deployment.buildFinishedAt ??
      new Date(24 * 60 * 60 * 1000);

    // Add 1 millisecond to fromDate to avoid duplicate logs
    fromDate = new Date(fromDate.getTime() + 1);

    const toDate = new Date();

    const logs = await this.#gatherMachineLogs(deployment, fromDate, toDate);

    const filteredLogs = logs.filter((log) => filterLine(log.message));

    // Create a new log for each line
    await this.#prismaClient.deploymentLog.createMany({
      data: filteredLogs.map((log, index) =>
        createLogRecord(deployment.id, index, log, "MACHINE")
      ),
      skipDuplicates: true,
    });

    return filteredLogs.length;
  }

  async #gatherMachineLogs(
    deployment: ProjectDeployment,
    fromDate: Date,
    toDate: Date,
    paginationToken?: string,
    logs: LogLine[] = []
  ): Promise<Array<LogLine>> {
    if (!deployment.vmIdentifier) {
      return [];
    }

    const logsResponse = await getVmLogs(deployment.vmIdentifier, {
      from: fromDate,
      to: toDate,
      batch: 100,
      pagination: paginationToken,
    });

    if (logsResponse.pagination) {
      return this.#gatherMachineLogs(
        deployment,
        fromDate,
        toDate,
        logsResponse.pagination,
        logs.concat(logsResponse.lines)
      );
    }

    return logs.concat(logsResponse.lines);
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
