import { LockOpenIcon } from "@heroicons/react/24/solid";
import { useOrganization } from "~/hooks/useOrganizations";
import { v3BillingPath } from "~/utils/pathBuilder";
import { LinkButton } from "./Buttons";
import { Header3 } from "./Headers";
import { Paragraph } from "./Paragraph";

type Props = {
  title: string;
  children: React.ReactNode;
  to?: string;
};

export function UpgradeCallout({ title, children, to }: Props) {
  const organization = useOrganization();

  to = to || v3BillingPath(organization);

  return (
    <div
      className="flex w-fit flex-col items-start justify-between gap-3 rounded-md border border-indigo-400/20
        bg-indigo-800/10 p-4"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <LockOpenIcon className="size-6 text-indigo-500" />
        <LinkButton to={to} variant="secondary/small">
          Upgrade
        </LinkButton>
      </div>
      <div className="flex flex-col gap-1">
        <Header3 className="text-text-bright">{title}</Header3>
        {typeof children === "string" ? (
          <Paragraph variant={"small"} className="text-text-dimmed">
            {children}
          </Paragraph>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
