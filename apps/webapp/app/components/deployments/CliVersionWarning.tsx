import { useDocsLink } from "~/components/DocsPanel";
import { InlineCode } from "~/components/code/InlineCode";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { CliVersionWarning } from "~/presenters/v3/cliVersionWarning.server";

const updateCommand = <InlineCode>npx trigger.dev@latest update</InlineCode>;

export function CliVersionWarningCallout({ warning }: { warning: CliVersionWarning }) {
  const docsLink = useDocsLink();
  const variant = warning.enforced ? "error" : "warning";
  return (
    <Callout
      variant={variant}
      className="rounded-none border-x-0 border-t-0"
      cta={
        <LinkButton variant="secondary/small" {...docsLink("cli-update-commands")} target="_blank">
          Upgrade guide
        </LinkButton>
      }
    >
      <Paragraph variant="small" className={variantClasses[variant].textColor}>
        {warning.enforced ? (
          <>
            The latest deploy used trigger.dev v{warning.cliVersion}, which is no longer supported
            for new deploys. Please upgrade to v{warning.minimum} or higher by running{" "}
            {updateCommand}.
          </>
        ) : (
          <>
            The latest deploy used trigger.dev v{warning.cliVersion}. Deploys from versions below v
            {warning.minimum} will no longer be supported after {warning.lastSupportedDay}. Run{" "}
            {updateCommand} to upgrade.
          </>
        )}
      </Paragraph>
    </Callout>
  );
}

export function CliVersionWarningBadge({ warning }: { warning: CliVersionWarning }) {
  return (
    <SimpleTooltip
      tabbable
      button={
        <Badge
          variant="extra-small"
          className={
            warning.enforced ? "text-error system:bg-error" : "text-warning system:bg-warning"
          }
        >
          {warning.enforced ? "Unsupported" : "Upgrade soon"}
        </Badge>
      }
      content={
        warning.enforced
          ? `No longer supported for new deploys. Please upgrade to v${warning.minimum} or higher.`
          : `Deploys from versions below v${warning.minimum} will no longer be supported after ${warning.lastSupportedDay}.`
      }
    />
  );
}
