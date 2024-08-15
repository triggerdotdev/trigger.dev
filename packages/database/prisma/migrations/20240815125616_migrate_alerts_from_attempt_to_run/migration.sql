-- Migrate existing alert channels from "TASK_RUN_ATTEMPT" to "TASK_RUN"
UPDATE "ProjectAlertChannel"
SET "alertTypes" = array_replace("alertTypes", 'TASK_RUN_ATTEMPT'::"ProjectAlertType", 'TASK_RUN'::"ProjectAlertType")
WHERE 'TASK_RUN_ATTEMPT'::"ProjectAlertType" = ANY("alertTypes");