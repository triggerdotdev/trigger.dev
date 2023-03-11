import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";
import { Link } from "@remix-run/react";
import { ProjectMenu } from "~/features/ee/projects/components/ProjectMenu";
import { useOptionalUser } from "~/hooks/useUser";
import { EnvironmentMenu } from "../../routes/resources/environment";
import { OrganizationMenu } from "../navigation/OrganizationMenu";
import { WorkflowMenu } from "../navigation/WorkflowMenu";
import { SecondaryA } from "../primitives/Buttons";
import { UserProfileMenu } from "../UserProfileMenu";

type HeaderProps = {
  children?: React.ReactNode;
  context: "workflows" | "projects";
};

export function Header({ children, context }: HeaderProps) {
  const user = useOptionalUser();

  return (
    <div className="sticky top-0 z-50 flex h-[3.6rem] w-full items-center gap-2 border-b border-slate-800 bg-slate-950 py-1 pl-2 pr-3">
      <div className="hidden items-center sm:flex">
        <OrganizationMenu />
        {context === "workflows" ? <WorkflowMenu /> : <ProjectMenu />}
        <EnvironmentMenu />
      </div>
      <div className="flex flex-1 justify-center">{children}</div>
      <div className="flex items-center gap-2">
        <SecondaryA href="https://docs.trigger.dev" target="_blank">
          <ArrowTopRightOnSquareIcon className="-ml-1 h-4 w-4" />
          Documentation
        </SecondaryA>
        <SecondaryA href="mailto:help@trigger.dev">
          <ChatBubbleLeftRightIcon className="-ml-1 h-4 w-4" />
          Send us feedback
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
        opacity={0.3}
        stroke="white"
        strokeLinecap="round"
      />
    </svg>
  );
}
