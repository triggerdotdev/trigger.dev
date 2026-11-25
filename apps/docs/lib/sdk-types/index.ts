// Types the <SdkType name="..." /> tables read. Generic SDK types are instantiated here
// so the tables show what a task author writes. Add a line to document another type.
import type {
  TaskOptions as SdkTaskOptions,
  TriggerOptions as SdkTriggerOptions,
} from "@trigger.dev/sdk";

export type TaskOptions = SdkTaskOptions<string, unknown, unknown>;
export type TriggerOptions = SdkTriggerOptions;
