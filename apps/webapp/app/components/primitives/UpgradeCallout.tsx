import { RocketLaunchIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { useOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
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
    <Link
      to={to}
      className={cn(
        `flex w-full items-start justify-between gap-2.5 rounded-md border px-3 py-3 shadow-md backdrop-blur-sm`,
        "border-indigo-400/20 bg-indigo-800/10 text-indigo-400"
      )}
    >
      <div className={"flex w-full items-start gap-x-2"}>
        <RocketLaunchIcon className="size-5" />
        <div className="flex flex-col gap-2">
          <Paragraph variant={"base"} className="text-indigo-200">
            {title}
          </Paragraph>
          {typeof children === "string" ? (
            <Paragraph variant={"small"} className="text-indigo-300">
              {children}
            </Paragraph>
          ) : (
            children
          )}
          <div className={cn("rounded-sm bg-indigo-500/50 px-3 py-1.5 text-sm text-indigo-200")}>
            Upgrade
          </div>
        </div>
      </div>
    </Link>
  );
}
