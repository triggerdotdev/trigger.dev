import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";
import { ProjectMenu } from "~/features/ee/projects/components/ProjectMenu";
import { Logo } from "../Logo";
import { OrganizationMenu } from "../navigation/OrganizationMenu";
import { WorkflowMenu } from "../navigation/WorkflowMenu";
import { SecondaryA, SecondaryButton } from "../primitives/Buttons";

type HeaderProps = {
  children?: React.ReactNode;
  context: "workflows" | "projects";
};

export function Header({ children, context }: HeaderProps) {
  return (
    <div className="z-50 flex h-[3.6rem] w-full items-center gap-2 border-b border-slate-800 bg-slate-950 py-1 pl-2 pr-2.5">
      <div className="hidden items-center lg:flex">
        <OrganizationMenu />
        {context === "workflows" ? <WorkflowMenu /> : <ProjectMenu />}
      </div>
      <Logo className="ml-1 w-36 lg:hidden" />
      <div className="flex flex-1 justify-center">{children}</div>
      <div className="flex items-center gap-2">
        <SecondaryA href="https://docs.trigger.dev" target="_blank">
          <ArrowTopRightOnSquareIcon className="-ml-1 h-4 w-4" />
          Doc<span className="-ml-2 hidden lg:block">umentation</span>
          <span className="-ml-2 lg:hidden">s</span>
        </SecondaryA>
        <SecondaryButton data-attr="posthog-feedback-button">
          <ChatBubbleLeftRightIcon className="-ml-1 h-4 w-4" />
          Send <span className="-mx-1 hidden lg:block">us</span> feedback
        </SecondaryButton>
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
