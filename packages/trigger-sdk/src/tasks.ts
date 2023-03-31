import type {
  DeserializedJson,
  DisplayProperty,
  SerializableJson,
} from "@trigger.dev/internal";

export type TaskStatus = "pending" | "running" | "completed" | "error";

export type TaskOptions = {
  id: string;
  name: string;
  timestamp: number;
  startedAt: Date;
  finishedAt?: Date;
  delayUntil?: Date;
  status: TaskStatus;
  description?: string;
  displayProperties?: DisplayProperty[];
  params?: SerializableJson;
  output?: DeserializedJson;
  error?: string;
};

export class Task {
  readonly options: TaskOptions;

  constructor(options: TaskOptions) {
    this.options = options;
  }
}
