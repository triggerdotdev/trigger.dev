import {
  BackgroundTask,
  BackgroundTaskMachine,
  BackgroundTaskMachinePool,
} from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { backgroundTaskProvider } from "./provider.server";
import { CreateExternalMachineService } from "./createExternalMachine.server";

const frequency = 1000 * 30; // 30 seconds

export class AutoScalePoolService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const pool = await this.#prismaClient.backgroundTaskMachinePool.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        _count: {
          select: {
            operations: {
              where: {
                status: "ASSIGNED_TO_POOL",
              },
            },
          },
        },
        machines: true,
        backgroundTask: true,
        backgroundTaskVersion: true,
      },
    });

    // Index the machines to gather the current state of the pool

    // If there are no operations, we can re-enqueue this job
    if (pool._count.operations === 0) {
      return await AutoScalePoolService.enqueue(pool, this.#prismaClient);
    }

    // TODO: we probably should just list all the machines for the app?

    const machines = await this.#autoScaleMachines(
      pool.backgroundTaskVersion.concurrency,
      pool,
      pool.machines,
      pool.backgroundTask
    );

    // We need to create any pending machines
    const pendingMachines = machines.filter((machine) => machine.status === "PENDING");

    for (const pendingMachine of pendingMachines) {
      await CreateExternalMachineService.enqueue(pendingMachine, this.#prismaClient);
    }

    await backgroundTaskProvider.cleanupForTask(pool.backgroundTask);

    await AutoScalePoolService.enqueue(pool, this.#prismaClient);
  }

  // If there are operations, we need to scale up the pool
  // Machines will automatically be restarted when they are returned to the pool
  // So we just need to make sure at least one machine is running
  // And if there is not, we need to start one
  // Status
  // machine statutes:
  // PENDING - The record has been created, but the machine has not on the provider
  // CREATED - The machine has been created on the provider
  // STARTING
  // STARTED - The machine is running
  // STOPPING
  // STOPPED
  // DESTROYING
  // DESTROYED - The machine has been destroyed on the provider
  // REPLACING - The machine config is being updated on the provider
  async #autoScaleMachines(
    target: number,
    pool: BackgroundTaskMachinePool,
    existingMachines: BackgroundTaskMachine[],
    task: BackgroundTask
  ): Promise<BackgroundTaskMachine[]> {
    const pendingMachines: BackgroundTaskMachine[] = [];

    // We need to update the pool to have the correct number of machines
    if (existingMachines.length < target) {
      const machinesToCreate = target - existingMachines.length;

      for (let i = 0; i < machinesToCreate; i++) {
        const pendingMachine = await this.#prismaClient.backgroundTaskMachine.create({
          data: {
            provider: backgroundTaskProvider.name,
            poolId: pool.id,
            backgroundTaskId: pool.backgroundTaskId,
            backgroundTaskVersionId: pool.backgroundTaskVersionId,
            backgroundTaskImageId: pool.imageId,
          },
        });

        pendingMachines.push(pendingMachine);
      }
    }

    const updatedExistingMachines = (
      await Promise.all(existingMachines.map(async (machine) => this.#indexMachine(machine, task)))
    ).filter(Boolean);

    const replacedMachines: BackgroundTaskMachine[] = [];

    if (updatedExistingMachines.length < existingMachines.length) {
      const machinesToReplace = existingMachines.length - updatedExistingMachines.length;

      for (let i = 0; i < machinesToReplace; i++) {
        const pendingMachine = await this.#prismaClient.backgroundTaskMachine.create({
          data: {
            provider: backgroundTaskProvider.name,
            poolId: pool.id,
            backgroundTaskId: pool.backgroundTaskId,
            backgroundTaskVersionId: pool.backgroundTaskVersionId,
            backgroundTaskImageId: pool.imageId,
          },
        });

        replacedMachines.push(pendingMachine);
      }
    }

    return [...pendingMachines, ...updatedExistingMachines, ...replacedMachines];
  }

  async #indexMachine(
    machine: BackgroundTaskMachine,
    task: BackgroundTask
  ): Promise<BackgroundTaskMachine | undefined> {
    // Using the provider get updated information about the machine (if it has an externalId)
    if (!machine.externalId) {
      return machine;
    }

    const externalMachine = await backgroundTaskProvider.getMachineForTask(
      machine.externalId,
      task
    );

    if (!externalMachine) {
      await this.#prismaClient.backgroundTaskMachine.delete({
        where: {
          id: machine.id,
        },
      });

      return;
    }

    return await this.#prismaClient.backgroundTaskMachine.update({
      where: {
        id: machine.id,
      },
      data: {
        status: externalMachine.status,
        data: externalMachine.data,
      },
    });
  }

  static async enqueue(
    pool: BackgroundTaskMachinePool,
    tx: PrismaClientOrTransaction = prisma,
    force = false
  ) {
    return await workerQueue.enqueue(
      "autoScalePool",
      {
        id: pool.id,
      },
      {
        tx,
        jobKey: `scale:${pool.id}`,
        runAt: force ? new Date() : new Date(Date.now() + frequency),
      }
    );
  }
}
