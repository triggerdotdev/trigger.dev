import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  EnvelopeIcon,
  LightBulbIcon,
  QuestionMarkCircleIcon,
  SignalIcon,
  StarIcon,
} from "@heroicons/react/20/solid";
import { cn } from "~/utils/cn";
import { DiscordIcon, SlackIcon } from "@trigger.dev/companyicons";
import { Fragment, useState } from "react";
import { useRecentChangelogs } from "~/routes/resources.platform-changelogs";
import { motion } from "framer-motion";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { Feedback } from "../Feedback";
import { Shortcuts } from "../Shortcuts";
import { StepContentContainer } from "../StepContentContainer";
import { Button } from "../primitives/Buttons";
import { ClipboardField } from "../primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { SimpleTooltip } from "../primitives/Tooltip";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { StepNumber } from "../primitives/StepNumber";
import { SideMenuItem } from "./SideMenuItem";
import { Badge } from "../primitives/Badge";

export function HelpAndFeedback({
  disableShortcut = false,
  isCollapsed = false,
}: {
  disableShortcut?: boolean;
  isCollapsed?: boolean;
}) {
  const [isHelpMenuOpen, setHelpMenuOpen] = useState(false);
  const currentPlan = useCurrentPlan();
  const { changelogs } = useRecentChangelogs();

  useShortcutKeys({
    shortcut: disableShortcut ? undefined : { key: "h", enabledOnInputElements: false },
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHelpMenuOpen(true);
    },
  });

  return (
    <motion.div
      layout="position"
      transition={{ duration: 0.2, ease: "easeInOut" }}
      className={isCollapsed ? undefined : "flex-1"}
    >
      <Popover open={isHelpMenuOpen} onOpenChange={setHelpMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center gap-1.5 rounded pl-[0.4375rem] pr-2 transition-colors hover:bg-charcoal-750 focus-custom",
              isCollapsed ? "w-full" : "w-full justify-between"
            )}
          >
            <span className="flex items-center gap-1.5 overflow-hidden">
              <QuestionMarkCircleIcon className="size-5 min-w-5 shrink-0 text-success" />
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap text-2sm text-text-bright transition-all duration-150",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[150px] opacity-100"
                )}
              >
                Help & Feedback
              </span>
            </span>
            <ShortcutKey
              className={cn(
                "size-4 flex-none transition-all duration-150",
                isCollapsed ? "hidden" : ""
              )}
              shortcut={{ key: "h" }}
              variant="medium/bright"
            />
          </PopoverTrigger>
        }
        content={
          <span className="flex items-center gap-1">
            Help & Feedback
            <ShortcutKey shortcut={{ key: "h" }} variant="medium/bright" />
          </span>
        }
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="!h-8 w-full"
        asChild
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[14rem] divide-y divide-grid-bright overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        side={isCollapsed ? "right" : "top"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
      >
        <Fragment>
          <div className="flex flex-col gap-1 p-1">
            <SideMenuItem
              name="Documentation"
              icon={BookOpenIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-green-500"
              activeIconColor="text-green-500"
              to="https://trigger.dev/docs"
              data-action="documentation"
              target="_blank"
            />
          </div>
          <div className="flex flex-col gap-1 p-1">
            <SideMenuItem
              name="Status"
              icon={SignalIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-green-500"
              activeIconColor="text-green-500"
              to="https://status.trigger.dev/"
              data-action="status"
              target="_blank"
            />
            <SideMenuItem
              name="Suggest a feature"
              icon={LightBulbIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-sun-500"
              activeIconColor="text-sun-500"
              to="https://feedback.trigger.dev/"
              data-action="suggest-a-feature"
              target="_blank"
            />
            <Shortcuts />
            <Feedback
              button={
                <Button
                  variant="small-menu-item"
                  className="pl-2"
                  LeadingIcon={EnvelopeIcon}
                  leadingIconClassName="text-blue-500 pr-1"
                  data-action="contact-us"
                  fullWidth
                  textAlignLeft
                >
                  Contact us…
                </Button>
              }
            />
          </div>
          <div className="flex flex-col gap-1 p-1">
            <Paragraph className="pb-1 pl-1.5 pt-1.5 text-xs">What's new</Paragraph>
            {changelogs.map((entry) => (
              <SideMenuItem
                key={entry.id}
                name={entry.title}
                icon={GrayDotIcon}
                trailingIcon={ArrowUpRightIcon}
                trailingIconClassName="text-text-dimmed"
                inactiveIconColor="text-text-dimmed"
                activeIconColor="text-text-dimmed"
                to={entry.actionUrl ?? "https://trigger.dev/changelog"}
                target="_blank"
              />
            ))}
            <SideMenuItem
              name="Full changelog"
              icon={StarIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-text-dimmed"
              activeIconColor="text-text-dimmed"
              to="https://trigger.dev/changelog"
              data-action="full-changelog"
              target="_blank"
            />
          </div>
        </Fragment>
      </PopoverContent>
      </Popover>
    </motion.div>
  );
}

function GrayDotIcon({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center justify-center", className)}>
      <span className="block h-1.5 w-1.5 rounded-full bg-text-dimmed" />
    </span>
  );
}
