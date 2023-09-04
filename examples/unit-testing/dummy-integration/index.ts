import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import * as tasks from "./tasks";

type DummyIntegrationOptions = {
  id: string;
};

export class DummyClient {
  methodOne() {}
  methodTwo() {}
}

export class Dummy implements TriggerIntegration<IntegrationClient<DummyClient, typeof tasks>> {
  client: IntegrationClient<DummyClient, typeof tasks>;

  constructor(private options: DummyIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: true,
      client: new DummyClient(),
      auth: {},
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "dummy", name: "Dummy" };
  }
}
