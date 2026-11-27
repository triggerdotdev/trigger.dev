import { EnvelopeIcon } from "@heroicons/react/20/solid";
import {
  type TaskRunError,
  type TaskRunErrorCause,
  taskRunErrorEnhancer,
} from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import { Button } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { Feedback } from "~/components/Feedback";
import { v3RunPathFromFriendlyId } from "~/utils/pathBuilder";
import {
  parseSupersededRunCancelReason,
  type SupersededRunCancelReason,
} from "~/utils/sessionMove";

type EnhancedRunError = ReturnType<typeof taskRunErrorEnhancer>;

const panelClassName = "flex flex-col gap-2";
const messageClassName =
  "text-wrap font-sans text-sm font-normal text-rose-500 dark:text-rose-200 [word-break:break-word]";

/** Every error gets a title. Only BUILT_IN_ERROR and INTERNAL_ERROR carry one of
 *  their own, and either can be empty, so everything else falls back to "Error". */
function errorTitle(error: EnhancedRunError): string {
  switch (error.type) {
    case "BUILT_IN_ERROR":
      return error.name || "Error";
    case "INTERNAL_ERROR":
      return error.code || "Error";
    case "STRING_ERROR":
    case "CUSTOM_ERROR":
      return "Error";
  }
}

/**
 * `status` is the run's status. The "Session moved" notice needs `CANCELED`: only the session run
 * manager cancels with that reason, but a task can throw the same text and fail.
 */
export function RunError({ error, status }: { error: TaskRunError; status?: TaskRunStatus }) {
  const moved =
    status === "CANCELED" && error.type === "STRING_ERROR"
      ? parseSupersededRunCancelReason(error.raw)
      : undefined;
  if (moved) return <SessionMovedNotice reason={moved} />;

  const enhancedError = taskRunErrorEnhancer(error);

  return (
    <div className={panelClassName}>
      <Header3 className="text-rose-500">{errorTitle(enhancedError)}</Header3>
      <RunErrorBody error={enhancedError} />
    </div>
  );
}

/**
 * A run canceled because its session moved to a newer version. Nothing failed, so it is shown as
 * information, with a link to the run the session continued in.
 */
function SessionMovedNotice({ reason }: { reason: SupersededRunCancelReason }) {
  return (
    <div className={panelClassName}>
      <Header3>Session moved</Header3>
      <Callout variant="info">
        <Paragraph variant="small" className={variantClasses.info.textColor}>
          Moved to {reason.movedToVersion} by the skew protection threshold
          {reason.taskIdentifier ? ` for ${reason.taskIdentifier}` : ""}. Continued in{" "}
          <TextLink to={v3RunPathFromFriendlyId(reason.newRunFriendlyId)}>
            {reason.newRunFriendlyId}
          </TextLink>
        </Paragraph>
      </Callout>
    </div>
  );
}

function RunErrorBody({ error: enhancedError }: { error: EnhancedRunError }) {
  switch (enhancedError.type) {
    case "STRING_ERROR":
      return <Callout variant="error">{enhancedError.raw}</Callout>;
    case "CUSTOM_ERROR": {
      return (
        <CodeBlock
          showCopyButton={false}
          showLineNumbers={false}
          code={enhancedError.raw}
          maxLines={20}
        />
      );
    }
    case "BUILT_IN_ERROR":
    case "INTERNAL_ERROR": {
      return (
        <>
          {enhancedError.message && (
            <Callout variant="error">
              <pre className={messageClassName}>{enhancedError.message}</pre>
            </Callout>
          )}
          {enhancedError.link &&
            (enhancedError.link.magic === "CONTACT_FORM" ? (
              <Feedback
                button={
                  <Button
                    variant="tertiary/medium"
                    LeadingIcon={EnvelopeIcon}
                    leadingIconClassName="text-blue-400"
                    fullWidth
                    textAlignLeft
                  >
                    {enhancedError.link.name}
                  </Button>
                }
              />
            ) : (
              <Callout variant="docs" to={enhancedError.link.href}>
                {enhancedError.link.name}
              </Callout>
            ))}
          {enhancedError.stackTrace && (
            <CodeBlock
              showCopyButton={false}
              showLineNumbers={false}
              code={enhancedError.stackTrace}
              maxLines={20}
            />
          )}
          {"causes" in enhancedError && enhancedError.causes?.length ? (
            <RunErrorCauses causes={enhancedError.causes} />
          ) : null}
        </>
      );
    }
  }
}

function RunErrorCauses({ causes }: { causes: TaskRunErrorCause[] }) {
  const visible = causes.filter((cause) => cause.name || cause.message || cause.stackTrace);

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-l border-rose-500/30 pl-3">
      {visible.map((cause, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Paragraph variant="small" className="text-rose-500">
            Caused by{cause.name ? `: ${cause.name}` : null}
          </Paragraph>
          {cause.message && <pre className={messageClassName}>{cause.message}</pre>}
          {cause.stackTrace && (
            <CodeBlock
              showCopyButton={false}
              showLineNumbers={false}
              code={cause.stackTrace}
              maxLines={12}
            />
          )}
        </div>
      ))}
    </div>
  );
}
