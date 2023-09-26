import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Page, Collection } from "replicate";

import { ReplicateRunTask } from "./index";
import { ReplicateReturnType } from "./types";

export class Collections {
  constructor(private runTask: ReplicateRunTask) {}

  get(key: IntegrationTaskKey, params: { slug: string }): ReplicateReturnType<Collection> {
    return this.runTask(
      key,
      (client) => {
        return client.collections.get(params.slug);
      },
      {
        name: "Get Collection",
        params,
        properties: [{ label: "Collection Slug", text: params.slug }],
      }
    );
  }

  list(key: IntegrationTaskKey): ReplicateReturnType<Page<Collection>> {
    return this.runTask(
      key,
      (client) => {
        return client.collections.list();
      },
      {
        name: "List Collections",
      }
    );
  }
}
