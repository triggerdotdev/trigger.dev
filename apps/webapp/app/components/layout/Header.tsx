import { DocumentTextIcon } from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { useOptionalUser } from "~/hooks/useUser";
import { Logo } from "../Logo";
import { EnvironmentMenu } from "../../routes/resources/environment";
import { OrganizationMenu } from "../navigation/OrganizationMenu";
import { WorkflowMenu } from "../navigation/WorkflowMenu";
import { SecondaryA } from "../primitives/Buttons";
import { UserProfileMenu } from "../UserProfileMenu";

type HeaderProps = {
  children?: React.ReactNode;
};

export function Header({ children }: HeaderProps) {
  const user = useOptionalUser();

  return (
    <div className="flex w-full gap-2 items-center border-b border-slate-800 bg-slate-950 py-1 px-2">
      <Link to="/" aria-label="Trigger" className="mr-2">
        <Logo className="h-6" />
      </Link>

      <OrganizationMenu />
      <WorkflowMenu />
      <EnvironmentMenu />

      <div className="flex flex-1 justify-center">{children}</div>

      <div className="flex items-center gap-2">
        <SecondaryA href="https://docs.apihero.run" target="_blank">
          <DocumentTextIcon className="h-4 w-4" />
          Docs
        </SecondaryA>
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
        opacity={0.8}
        stroke="white"
        strokeLinecap="round"
      />
    </svg>
  );
}
