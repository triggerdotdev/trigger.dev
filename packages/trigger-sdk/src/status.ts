import { DisplayProperty, StatusUpdate } from "@trigger.dev/core/schemas";
import { IntegrationTaskKey } from "./integrations";
import { IO } from "./io";
import { TriggerClient } from "./triggerClient";

export class TriggerStatus {
  constructor(
    private id: string,
    private io: IO
  ) {}

  async update(key: IntegrationTaskKey, status: StatusUpdate) {
    const properties: DisplayProperty[] = [];

    if (status.label) {
      properties.push({
        label: "Label",
        text: status.label,
      });
    }

    if (status.state) {
      properties.push({
        label: "State",
        text: status.state,
      });
    }

    return await this.io.runTask(
      key,
      async (task) => {
        return await this.io.triggerClient.updateStatus(this.io.runId, this.id, status);
      },
      {
        name: status.label ?? `Status update`,
        icon: "clock",
        params: {
          ...status,
        },
        properties,
      }
    );
  }
}
