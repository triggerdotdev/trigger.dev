import { Popover, Transition } from "@headlessui/react";
import { BookOpenIcon, ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { Fragment } from "react";
import { cn } from "~/utils/cn";
import { Feedback } from "../Feedback";
import { LogoIcon } from "../LogoIcon";
import { Button, LinkButton } from "../primitives/Buttons";
import { Breadcrumb } from "./Breadcrumb";
import { docsRoot } from "~/utils/pathBuilder";

export function NavBar() {
  return (
    <div className="z-50 flex w-full items-center justify-between gap-2 border-b border-uiBorder py-1 pl-1 pr-2.5">
      <div className="flex gap-0.5">
        <Link to="/" className="p-2">
          <LogoIcon className="h-5 w-5" />
        </Link>
        <Breadcrumb />
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <LinkButton to={docsRoot()} variant="secondary/small" LeadingIcon={BookOpenIcon}>
          Documentation
        </LinkButton>
        <Feedback
          button={
            <Button
              variant="secondary/small"
              LeadingIcon={ChatBubbleLeftRightIcon}
              shortcut={{ key: "f" }}
            >
              Help & feedback
            </Button>
          }
        />
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
