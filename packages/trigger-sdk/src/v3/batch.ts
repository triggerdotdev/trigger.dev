import {
  batchTriggerById,
  batchTriggerByIdAndWait,
  batchTriggerTasks,
  batchTriggerAndWaitTasks,
} from "./shared.js";

export const batch = {
  trigger: batchTriggerById,
  triggerAndWait: batchTriggerByIdAndWait,
  triggerByTask: batchTriggerTasks,
  triggerByTaskAndWait: batchTriggerAndWaitTasks,
};
