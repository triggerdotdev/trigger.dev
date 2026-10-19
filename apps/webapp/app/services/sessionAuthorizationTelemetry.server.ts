import type { RbacAbility } from "@trigger.dev/rbac";

export function sessionCreateAuthorizationOutcome(
  ability: RbacAbility,
  taskIdentifier: string,
  sessionIds: string[] = []
) {
  const sessionWrite =
    ability.can("write", { type: "sessions" }) ||
    sessionIds.some((id) => ability.can("write", { type: "sessions", id }));
  const taskTrigger = ability.can("trigger", { type: "tasks", id: taskIdentifier });

  if (sessionWrite && taskTrigger) return "both_allowed";
  if (!sessionWrite && !taskTrigger) return "missing_both";
  return sessionWrite ? "missing_task_trigger" : "missing_session_write";
}
