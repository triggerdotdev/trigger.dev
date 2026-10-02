import type { WebhookRoutingTarget } from "@trigger.dev/core/v3";
import { Badge } from "~/components/primitives/Badge";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3AgentTaskPath, v3WebhookTaskPath } from "~/utils/pathBuilder";
import { webhookSubscriberKind } from "~/v3/webhookSetupPrompt";

/** Keys are stored with `{body.x}`; show them in the `{event.x}` form the SDK takes. */
function displayKeyTemplate(template: string): string {
  return template.replace(/(\{\s*|\|\|\s*)body(?=[.}\s|])/g, "$1event");
}

function InfoText({ children }: { children: string }) {
  return (
    <Paragraph variant="small" className="max-w-xs p-1 text-wrap! text-text-dimmed">
      {children}
    </Paragraph>
  );
}

/** Every subscriber of an endpoint: where a delivery goes and which filter it must pass. */
export function EndpointSubscribersTable({ targets }: { targets: WebhookRoutingTarget[] }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <Table className="max-h-full overflow-y-auto" showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Subscriber</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <InfoText>
                A task is a webhook() task, triggered once per delivery. An agent event is a
                chat.event on an agent, delivered to the session its key resolves to. A channel
                feeds a chat channel connector.
              </InfoText>
            }
          >
            Type
          </TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <InfoText>
                Checked against each delivery. A subscriber without a filter receives every
                delivery, and a delivery no subscriber accepts is recorded as filtered.
              </InfoText>
            }
          >
            Filter
          </TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <InfoText>
                For agent events and channels: the key template that picks the session a delivery
                goes to, and the filter that starts a new session when none exists yet.
              </InfoText>
            }
          >
            Session
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {targets.length === 0 ? (
          <TableBlankRow colSpan={5}>
            <Paragraph variant="small" className="text-center text-text-dimmed">
              No subscribers. Deliveries are recorded as filtered until a task, agent event or
              channel subscribes to this endpoint.
            </Paragraph>
          </TableBlankRow>
        ) : (
          targets.map((target) => {
            const taskId = target.type === "task" ? target.taskId : target.taskIdentifier;
            const taskPath =
              target.type === "task"
                ? v3WebhookTaskPath(organization, project, environment, taskId)
                : v3AgentTaskPath(organization, project, environment, taskId);
            return (
              <TableRow key={target.id}>
                <TableCell to={taskPath}>
                  <span className="font-mono text-xs text-text-bright">{target.id}</span>
                </TableCell>
                <TableCell to={taskPath}>
                  <Badge variant="extra-small">{webhookSubscriberKind(target)}</Badge>
                </TableCell>
                <TableCell to={taskPath}>
                  <span className="font-mono text-xs">{taskId}</span>
                </TableCell>
                <TableCell to={taskPath}>
                  {target.filter ? (
                    <code className="block max-w-sm whitespace-normal break-words text-xs text-text-bright">
                      {target.filter}
                    </code>
                  ) : (
                    <span className="text-text-dimmed">Every delivery</span>
                  )}
                </TableCell>
                <TableCell to={taskPath}>
                  {target.type === "session" ? (
                    <span className="flex max-w-xs flex-col gap-0.5 whitespace-normal break-words text-xs text-text-dimmed">
                      <span>
                        Key{" "}
                        <code className="text-text-bright">
                          {displayKeyTemplate(target.keyTemplate)}
                        </code>
                      </span>
                      {target.startOn ? (
                        <span>
                          Starts on <code className="text-text-bright">{target.startOn}</code>
                        </span>
                      ) : null}
                      {target.actionType ? (
                        <span>
                          Action <code className="text-text-bright">{target.actionType}</code>
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-text-dimmed">None</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
