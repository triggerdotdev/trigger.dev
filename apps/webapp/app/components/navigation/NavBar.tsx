import { Popover, Transition } from "@headlessui/react";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import { Fragment } from "react";
import { cn } from "~/utils/cn";
import { LogoIcon } from "../LogoIcon";
import { BreadcrumbIcon } from "../primitives/BreadcrumbIcon";
import { Button, LinkButton } from "../primitives/Buttons";
import { Breadcrumb } from "./Breadcrumb";

export function NavBar() {
  return (
    <div className="z-50 flex w-full items-center justify-between gap-2 border-b border-divide py-1 pl-2 pr-2.5">
      <div className="flex gap-0.5">
        <Link to="/" className="p-2">
          <LogoIcon className="h-5 w-5" />
        </Link>
        <Breadcrumb />
        <MobileDropdownMenu />
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <LinkButton
          to="https://docs.trigger.dev"
          variant="secondary/small"
          LeadingIcon={BookOpenIcon}
        >
          Documentation
        </LinkButton>
        <Button
          variant="secondary/small"
          data-attr="posthog-feedback-button"
          LeadingIcon={ChatBubbleLeftRightIcon}
          shortcut="F"
        >
          Send us feedback
        </Button>
      </div>
    </div>
  );
}

export function BreadcrumbLink({ title, to }: { title: string; to: string }) {
  return (
    <LinkButton to={to} variant="tertiary/small">
      {title}
    </LinkButton>
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
          <Popover.Overlay className="absolute left-0 top-0 h-full w-full origin-top bg-midnight-900/80" />
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
