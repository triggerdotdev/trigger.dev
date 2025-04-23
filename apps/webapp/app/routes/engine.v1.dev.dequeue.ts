import { json } from "@remix-run/server-runtime";
import { DequeuedMessage, DevDequeueRequestBody, MachineResources } from "@trigger.dev/core/v3";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";
import { env } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: DevDequeueRequestBody,
    maxContentLength: 1024 * 10, // 10KB
    method: "POST",
  },
  async ({ authentication, body }) => {
    //we won't return more runs than this in one API call
    let maxDequeueCount = env.DEV_DEQUEUE_MAX_RUNS_PER_PULL;

    //we can't use more than the max resources
    const availableResources = body.maxResources ?? {
      cpu: 8,
      memory: 16,
    };

    let dequeuedMessages: DequeuedMessage[] = [];

    //we need to check the current worker, because a run might have been locked to it
    const workers = body.oldWorkers.concat(body.currentWorker);

    //first we want to clear out old runs
    for (const worker of workers) {
      //dequeue
      const latestResult = await engine.dequeueFromBackgroundWorkerMasterQueue({
        consumerId: authentication.environment.id,
        //specific version
        backgroundWorkerId: BackgroundWorkerId.toId(worker),
        maxRunCount: maxDequeueCount,
        maxResources: availableResources,
      });

      //add runs to the array
      dequeuedMessages.push(...latestResult);

      //update availableResources
      const consumedResources = latestResult.reduce(
        (acc, r) => {
          return {
            cpu: acc.cpu + r.run.machine.cpu,
            memory: acc.memory + r.run.machine.memory,
          };
        },
        { cpu: 0, memory: 0 }
      );
      updateAvailableResources(availableResources, consumedResources);

      //update maxDequeueCount
      maxDequeueCount -= latestResult.length;

      //if we have no resources left, we exit the loop
      if (!hasAvailableResources(availableResources)) break;
      //we've already dequeued the max number of runs
      if (maxDequeueCount <= 0) break;
    }

    //dequeue from the current version if we still have space
    if (hasAvailableResources(availableResources) && maxDequeueCount > 0) {
      const latestResult = await engine.dequeueFromEnvironmentMasterQueue({
        consumerId: authentication.environment.id,
        //current dev version (no specific version specified)
        environmentId: authentication.environment.id,
        maxRunCount: maxDequeueCount,
        maxResources: availableResources,
      });
      dequeuedMessages.push(...latestResult);
    }

    return json({ dequeuedMessages }, { status: 200 });
  }
);

function updateAvailableResources(
  availableResources: MachineResources,
  resources: MachineResources
) {
  availableResources.cpu -= resources.cpu;
  availableResources.memory -= resources.memory;
}

function hasAvailableResources(availableResources: MachineResources) {
  return availableResources.cpu > 0 && availableResources.memory > 0;
}

export { action };
