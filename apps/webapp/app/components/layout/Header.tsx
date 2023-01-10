import { DocumentTextIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { useOptionalUser } from "~/hooks/useUser";
import { Logo } from "../Logo";
import { EnvironmentMenu } from "../../routes/resources/environment";
import { OrganizationMenu } from "../navigation/OrganizationMenu";
import { WorkflowMenu } from "../navigation/WorkflowMenu";
import { TertiaryA } from "../primitives/Buttons";
import { UserProfileMenu } from "../UserProfileMenu";

type HeaderProps = {
  children?: React.ReactNode;
};

export function Header({ children }: HeaderProps) {
  const user = useOptionalUser();

  return (
    <div className="flex w-full gap-2 items-center border-b border-slate-800 bg-slate-950 py-1 pl-4 pr-3">
      <Link to="/" aria-label="Trigger" className="flex shrink-0 mr-2 w-28">
        <Logo className="" />
      </Link>
      <OrganizationMenu />
      <WorkflowMenu />
      <EnvironmentMenu />

      <div className="flex flex-1 justify-center">{children}</div>

      <div className="flex items-center gap-1">
        <TertiaryA href="https://docs.trigger.dev" target="_blank">
          <DocumentTextIcon className="h-5 w-5" />
          Docs
        </TertiaryA>
        {user ? (
          <UserProfileMenu user={user} />
        ) : (
          <Link
            to="/login"
            className="text-gray-700 transition hover:text-black"
          >
            Login
          </Link>
        )}
      </div>
    </div>
  );
}

export function BreadcrumbDivider() {
  return (
    <svg
      width="9"
      height="20"
      viewBox="0 0 9 26"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <line
        x1="8.32382"
        y1="0.6286"
        x2="0.6286"
        y2="24.6762"
        opacity={0.5}
        stroke="white"
        strokeLinecap="round"
      />
    </svg>
  );
}
