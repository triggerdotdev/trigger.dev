import { Link, useNavigation } from "@remix-run/react";
import { type ReactNode } from "react";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { UpgradePrompt, useShowUpgradePrompt } from "../billing/UpgradePrompt";
import { BreadcrumbIcon } from "./BreadcrumbIcon";
import { Header2 } from "./Headers";
import { LoadingBarDivider } from "./LoadingBarDivider";
import { EnvironmentBanner } from "../navigation/EnvironmentBanner";

type WithChildren = {
  children: React.ReactNode;
  className?: string;
};

export function NavBar({ children }: WithChildren) {
  const organization = useOptionalOrganization();
  const showUpgradePrompt = useShowUpgradePrompt(organization);

  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  return (
    <div>
      <div className="grid h-10 w-full grid-rows-[auto_1px] bg-background-bright">
        <div className="flex w-full items-center justify-between pl-3 pr-2">{children}</div>
        <LoadingBarDivider isLoading={isLoading} />
      </div>
      {showUpgradePrompt.shouldShow && organization ? <UpgradePrompt /> : <EnvironmentBanner />}
    </div>
  );
}

type PageTitleProps = {
  title: ReactNode;
  backButton?: {
    to: string;
    text: string;
  };
};

export function PageTitle({ title, backButton }: PageTitleProps) {
  return (
    <div className="flex items-center gap-2">
      {backButton && (
        <div className="group -ml-1.5 flex items-center gap-0">
          <Link
            to={backButton.to}
            className="rounded px-1.5 py-1 text-xs text-text-dimmed transition focus-custom group-hover:bg-charcoal-700 group-hover:text-text-bright"
          >
            {backButton.text}
          </Link>
          <BreadcrumbIcon className="h-5" />
        </div>
      )}
      <Header2 className="flex items-center gap-1">{title}</Header2>
    </div>
  );
}

export function PageAccessories({ children }: WithChildren) {
  return <div className="flex items-center gap-2">{children}</div>;
}
