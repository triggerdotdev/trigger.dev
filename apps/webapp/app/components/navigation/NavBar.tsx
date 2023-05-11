import { Popover, Transition } from "@headlessui/react";
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";
import { Fragment } from "react";
import { ProjectsMenu } from "./ProjectsMenu";
import { JobsMenu } from "./JobsMenu";
import { LogoIcon } from "../LogoIcon";
import { Button, LinkButton } from "../primitives/Buttons";
import { cn } from "~/utils/cn";

export function NavBar() {
  return (
    <div className="z-50 flex h-[3.6rem] w-full items-center gap-2 border-b border-slate-800 bg-slate-950 py-1 pl-2 pr-2.5">
      <div className="hidden items-center lg:flex">
        <ProjectsMenu />
        <JobsMenu />
      </div>
      <LogoIcon className="ml-1" />
      <MobileDropdownMenu />
      <div className="hidden items-center gap-2 sm:flex">
        <LinkButton
          to="https://docs.trigger.dev"
          text="Documentation"
          size="medium"
          theme="secondary"
          LeadingIcon={ArrowTopRightOnSquareIcon}
        />
        <Button
          text="Send us feedback"
          size="medium"
          theme="secondary"
          data-attr="posthog-feedback-button"
          LeadingIcon={ChatBubbleLeftRightIcon}
        />
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

function MobileDropdownMenu() {
  return (
    <Popover className="block sm:hidden">
      <Popover.Button
        className="bg-slate-70 relative z-10 flex h-8 w-8 items-center justify-center rounded border-none bg-opacity-50 focus-visible:border-none focus-visible:outline-none"
        aria-label="Toggle Navigation"
      >
        {({ open }) => <MobileNavIcon open={open} />}
      </Popover.Button>
      <Transition.Root>
        <Transition.Child
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-150 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Popover.Overlay className="absolute top-0 left-0 h-full w-full origin-top bg-slate-1000/80" />
        </Transition.Child>
        <Transition.Child
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0 scale-95"
          enterTo="opacity-100 scale-100"
          leave="duration-100 ease-in"
          leaveFrom="opacity-100 scale-100"
          leaveTo="opacity-0 scale-95"
        >
          <Popover.Panel
            as="div"
            className="absolute inset-x-6 top-0 mt-20 flex origin-top flex-col gap-4 rounded-md bg-slate-800 p-4 text-lg tracking-tight text-slate-900 shadow-xl ring-1 ring-slate-700"
          >
            {/* <PrimaryA
              href="https://docs.trigger.dev"
              target="_blank"
              className="max-w-full"
            >
              <ArrowTopRightOnSquareIcon className="-ml-1 h-4 w-4" />
              Documentation
            </PrimaryA>
            <PrimaryButton
              data-attr="posthog-feedback-button"
              className="max-w-full"
            >
              <ChatBubbleLeftRightIcon className="-ml-1 h-4 w-4" />
              Send us feedback
            </PrimaryButton>
            <SecondaryLink to="/logout" className="max-w-full">
              Logout
            </SecondaryLink> */}
          </Popover.Panel>
        </Transition.Child>
      </Transition.Root>
    </Popover>
  );
}

function MobileNavIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 overflow-visible stroke-slate-300"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path
        d="M0 1H14M0 7H14M0 13H14"
        className={cn("origin-center transition", open && "scale-90 opacity-0")}
      />
      <path
        d="M2 2L12 12M12 2L2 12"
        className={cn(
          "origin-center transition",
          !open && "scale-90 opacity-0"
        )}
      />
    </svg>
  );
}
