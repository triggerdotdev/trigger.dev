import { VercelLogo } from "./VercelLogo";
import { LinkButton } from "~/components/primitives/Buttons";
import { SimpleTooltip } from "~/components/primitives/Tooltip";

export function VercelLink({ vercelDeploymentUrl }: { vercelDeploymentUrl: string }) {
  return (
    <SimpleTooltip
      button={
        <LinkButton
          variant="minimal/small"
          LeadingIcon={<VercelLogo className="size-3.5" />}
          iconSpacing="gap-x-1"
          to={vercelDeploymentUrl}
          className="pl-1"
        >
          Vercel
        </LinkButton>
      }
      content="View on Vercel"
    />
  );
}
