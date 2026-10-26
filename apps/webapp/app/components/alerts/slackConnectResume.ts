import type { FlowAnswers } from "~/components/dashboard-agent/alert-creation/flow-state";

const key = (projectId: string, environmentId: string) =>
  `alerts.slackConnectResume.${projectId}.${environmentId}`;

export function saveSlackConnectResume(
  projectId: string,
  environmentId: string,
  answers: FlowAnswers,
  manual?: boolean
) {
  try {
    sessionStorage.setItem(
      key(projectId, environmentId),
      JSON.stringify(manual ? { ...answers, manual } : answers)
    );
  } catch {}
}

export function readSlackConnectResume(
  projectId: string,
  environmentId: string
): (FlowAnswers & { manual?: boolean }) | undefined {
  try {
    const raw = sessionStorage.getItem(key(projectId, environmentId));
    return raw ? (JSON.parse(raw) as FlowAnswers & { manual?: boolean }) : undefined;
  } catch {
    return undefined;
  }
}

export function clearSlackConnectResume(projectId: string, environmentId: string) {
  try {
    sessionStorage.removeItem(key(projectId, environmentId));
  } catch {}
}
