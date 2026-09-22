import { LinkButton } from "~/components/primitives/Buttons";
import { SettingsRow } from "~/components/primitives/SettingsLayout";

export function VercelAtomicDeploymentNotice({ vercelUrl }: { vercelUrl: string }) {
  return (
    <SettingsRow
      bordered={false}
      className="flex-wrap gap-x-16 gap-y-4 [&>div:first-child]:basis-64"
      title="Deploy through Vercel"
      description="This project releases its app and tasks together through Vercel. Start the deployment in Vercel."
      action={
        <LinkButton variant="secondary/small" to={vercelUrl} target="_blank">
          Open Vercel
        </LinkButton>
      }
    />
  );
}
