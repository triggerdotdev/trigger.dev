import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { VercelRunTask } from ".";

export class Checks {
  runTask: VercelRunTask;

  constructor(runTask: VercelRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: {
      teamId: string;
      deploymentId: string;
      name: string;
      blocking: boolean;
      reRequestable?: boolean;
    }
  ) {
    return this.runTask(
      key,
      async (client, task, io) => {
        return await client.createCheck({ ...params });
      },
      {
        name: "Create Checks",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Deployment ID", text: params.deploymentId },
          { label: "Check Name", text: params.name },
        ],
      }
    );
  }
}
