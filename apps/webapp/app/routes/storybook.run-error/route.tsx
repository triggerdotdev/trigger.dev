import { type TaskRunError } from "@trigger.dev/core/v3";
import { RunError } from "~/components/runs/v3/RunError";
import { StoryPage, StorySection, StorySubSection } from "../storybook/StoryKit";

const stack = [
  "Error: Could not sync the customer",
  "    at run (/app/src/trigger/syncCustomer.ts:15:11)",
  "    at TaskExecutor.execute (/app/node_modules/@trigger.dev/core/dist/taskExecutor.js:431:24)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
].join("\n");

const causeStack = [
  "SequelizeConnectionError: Connection terminated unexpectedly",
  "    at Client._handleErrorWhileConnecting (/app/node_modules/pg/lib/client.js:327:19)",
  "    at Socket.reportStreamError (/app/node_modules/pg/lib/connection.js:57:12)",
].join("\n");

const builtIn = (overrides: Partial<Extract<TaskRunError, { type: "BUILT_IN_ERROR" }>> = {}) =>
  ({
    type: "BUILT_IN_ERROR",
    name: "Error",
    message: "Could not sync the customer",
    stackTrace: stack,
    ...overrides,
  }) satisfies TaskRunError;

const internal = (
  overrides: Partial<Extract<TaskRunError, { type: "INTERNAL_ERROR" }>> = {}
): TaskRunError => ({
  type: "INTERNAL_ERROR",
  code: "TASK_RUN_CRASHED",
  ...overrides,
});

/** Two panels side by side so the shapes are easy to compare. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>;
}

function Sample({ label, error }: { label: string; error: TaskRunError }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-xs text-text-dimmed">{label}</span>
      <RunError error={error} />
    </div>
  );
}

export default function Story() {
  return (
    <StoryPage
      title="Run error"
      componentNames={["RunError.tsx"]}
      description="The error panel on the run and span pages. One panel per TaskRunError variant, plus the cases where parts of the panel are absent."
    >
      <StorySection
        title="The four error types"
        description='Each TaskRunError variant renders a different body. Every one gets a title, falling back to "Error" for the types that carry no name of their own.'
      >
        <Row>
          <Sample label='type: "BUILT_IN_ERROR"' error={builtIn()} />
          <Sample
            label='type: "STRING_ERROR"'
            error={{ type: "STRING_ERROR", raw: "Something went wrong in the task" }}
          />
          <Sample
            label='type: "CUSTOM_ERROR"'
            error={{
              type: "CUSTOM_ERROR",
              raw: JSON.stringify({ code: "ENOENT", path: "/tmp/customer.json" }, null, 2),
            }}
          />
          <Sample
            label='type: "INTERNAL_ERROR"'
            error={internal({ code: "TASK_PROCESS_OOM_KILLED" })}
          />
        </Row>
      </StorySection>

      <StorySection
        title="With and without the message callout"
        description="The callout is rendered only when the error has a truthy message. INTERNAL_ERROR.message is optional in the schema, and most internal codes have no pretty message, so the no-callout case is common in practice."
      >
        <Row>
          <Sample label="message present" error={builtIn()} />
          <Sample label='message: "" (falsy, no callout)' error={builtIn({ message: "" })} />
          <Sample label='name: "" (title falls back to Error)' error={builtIn({ name: "" })} />
          <Sample
            label="INTERNAL_ERROR with a message"
            error={internal({ message: "The task process exited unexpectedly" })}
          />
          <Sample
            label="INTERNAL_ERROR with no message (code only)"
            error={internal({ code: "POD_EVICTED" })}
          />
        </Row>
      </StorySection>

      <StorySection
        title="With and without a stack trace"
        description="stackTrace is required on BUILT_IN_ERROR but may be empty, and is optional on INTERNAL_ERROR."
      >
        <Row>
          <Sample label="stack present" error={builtIn()} />
          <Sample label='stackTrace: "" (no code block)' error={builtIn({ stackTrace: "" })} />
        </Row>
      </StorySection>

      <StorySection
        title="Cause chains"
        description="A thrown error's cause chain, flattened outermost first and capped at five. Causes render subordinate to the thrown error: a label, the message, then the frames."
      >
        <Row>
          <Sample label="no causes" error={builtIn()} />
          <Sample
            label="one cause, with frames"
            error={builtIn({
              causes: [
                {
                  name: "SequelizeConnectionError",
                  message: "Connection terminated unexpectedly",
                  stackTrace: causeStack,
                },
              ],
            })}
          />
          <Sample
            label="three causes (a full chain)"
            error={builtIn({
              causes: [
                {
                  name: "SequelizeConnectionError",
                  message: "Connection terminated unexpectedly",
                  stackTrace: causeStack,
                },
                {
                  name: "AggregateError",
                  message: "connect ECONNREFUSED 10.0.4.17:5432",
                  stackTrace: "AggregateError: connect ECONNREFUSED 10.0.4.17:5432",
                },
                { name: "Error", message: "getaddrinfo ENOTFOUND db.internal" },
              ],
            })}
          />
          <Sample
            label="cause with no name (a non-Error cause)"
            error={builtIn({
              causes: [{ message: JSON.stringify({ code: "ENOENT" }) }],
            })}
          />
        </Row>
      </StorySection>

      <StorySection
        title="Cause edge cases"
        description="Shapes the serializer can produce, and shapes only older stored rows can produce. The component must not render a dangling label for any of them."
      >
        <Row>
          <Sample
            label="cause with no stack (message only)"
            error={builtIn({
              causes: [{ name: "TypeError", message: "Cannot read properties of undefined" }],
            })}
          />
          <Sample
            label="unserializable cause"
            error={builtIn({ causes: [{ message: "[unserializable object cause]" }] })}
          />
          <Sample
            label="empty causes array (renders nothing extra)"
            error={builtIn({ causes: [] })}
          />
          <Sample
            label="cause with nothing to show (filtered out)"
            error={builtIn({ causes: [{ message: "" }] })}
          />
        </Row>
      </StorySection>

      <StorySection
        title="Enhanced errors"
        description="taskRunErrorEnhancer rewrites some errors before rendering. The deadlock rewrite is the only built-in to built-in rewrite, and it carries the cause chain across."
      >
        <Row>
          <Sample
            label="deadlock (gets a docs link)"
            error={builtIn({
              name: "TriggerApiError",
              message: "Deadlock detected: the run is waiting on a task with no free concurrency",
            })}
          />
          <Sample
            label="deadlock with a cause"
            error={builtIn({
              name: "TriggerApiError",
              message: "Deadlock detected: the run is waiting on a task with no free concurrency",
              causes: [{ name: "TypeError", message: "inner failure" }],
            })}
          />
          <Sample
            label="OOM (rewritten to an internal error)"
            error={builtIn({ name: "Error", message: "ffmpeg was killed with signal SIGKILL" })}
          />
          <Sample label="contact-form link" error={internal({ code: "GRACEFUL_EXIT_TIMEOUT" })} />
        </Row>
      </StorySection>

      <StorySection
        title="Long content"
        description="Messages and frames must wrap or scroll rather than blow out the panel width."
      >
        <StorySubSection title="Unbroken string">
          <RunError
            error={builtIn({
              message: `Failed to parse response: ${"x".repeat(300)}`,
              causes: [{ name: "SyntaxError", message: "y".repeat(300) }],
            })}
          />
        </StorySubSection>
      </StorySection>
    </StoryPage>
  );
}
