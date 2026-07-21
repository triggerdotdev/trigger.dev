import { ArrowUpRightIcon } from "@heroicons/react/20/solid";
import { motion } from "framer-motion";
import { Fragment, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { BookIcon } from "~/assets/icons/BookIcon";
import { BulbIcon } from "~/assets/icons/BulbIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { EnvelopeIcon } from "~/assets/icons/EnvelopeIcon";
import { QuestionMarkIcon } from "~/assets/icons/QuestionMarkIcon";
import { RadarPulseIcon } from "~/assets/icons/RadarPulseIcon";
import { StarIcon } from "~/assets/icons/StarIcon";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { useRecentChangelogs } from "~/routes/resources.platform-changelogs";
import { cn } from "~/utils/cn";
import { sanitizeHttpUrl } from "~/utils/sanitizeUrl";
import { AskAIRoot } from "../AskAI";
import { Feedback } from "../Feedback";
import { Shortcuts } from "../Shortcuts";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/Popover";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { SimpleTooltip } from "../primitives/Tooltip";
import { SideMenuItem, SideMenuItemButton } from "./SideMenuItem";

export function HelpAndFeedback({
  disableShortcut = false,
  isCollapsed = false,
  organizationId,
  projectId,
}: {
  disableShortcut?: boolean;
  isCollapsed?: boolean;
  organizationId?: string;
  projectId?: string;
}) {
  const [isHelpMenuOpen, setHelpMenuOpen] = useState(false);
  const _currentPlan = useCurrentPlan();
  const { changelogs } = useRecentChangelogs(organizationId, projectId);

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
      className={isCollapsed ? undefined : "min-w-0 flex-1"}
    >
      {/* AskAIRoot hosts the Ask AI dialog + ⌘I shortcut outside the popover, so both survive the
          popover closing; the popover just renders the trigger. */}
      <AskAIRoot>
        {(openAskAI) => (
          <Popover open={isHelpMenuOpen} onOpenChange={setHelpMenuOpen}>
            <SimpleTooltip
              button={
                <PopoverTrigger
                  className={cn(
                    "group flex h-8 items-center gap-1.5 rounded pl-1.75 pr-2 hover:bg-background-hover focus-custom",
                    isCollapsed ? "w-full" : "w-full justify-between"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <QuestionMarkIcon className="size-5 min-w-5 shrink-0 text-success" />
                    {/*
                      Width + opacity follow --sm-label-opacity so the label tracks a drag both
                      directions (no CSS transition — it would lag the per-frame writes).
                    */}
                    <span
                      className="min-w-0 overflow-hidden whitespace-nowrap text-[0.90625rem] font-medium tracking-[-0.01em] text-text-dimmed group-hover:text-text-bright"
                      style={{
                        maxWidth: "calc(var(--sm-label-opacity, 1) * 150px)",
                        opacity: "var(--sm-label-opacity, 1)",
                      }}
                    >
                      Help & Feedback
                    </span>
                  </span>
                  {/*
                    Hover chevron, only when expanded. Its 16px width follows --sm-label-opacity so
                    an invisible chevron never holds width mid-drag and clips the help icon.
                  */}
                  {!isCollapsed && (
                    <span
                      className="overflow-hidden opacity-0 group-hover:opacity-100"
                      style={{ maxWidth: "calc(var(--sm-label-opacity, 1) * 16px)" }}
                    >
                      <DropdownIcon className="size-4 min-w-4 text-text-dimmed group-hover:text-text-bright" />
                    </span>
                  )}
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
              delayDuration={isCollapsed ? 0 : 500}
              buttonClassName="h-8! w-full"
              asChild
              tabbable
              disableHoverableContent
            />
            <PopoverContent
              className="min-w-56 divide-y divide-grid-bright overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
              side={isCollapsed ? "right" : "top"}
              sideOffset={isCollapsed ? 8 : 4}
              align="start"
            >
              <Fragment>
                {openAskAI !== undefined && (
                  <div className="flex flex-col gap-1 p-1">
                    <SideMenuItemButton
                      icon={AISparkleIcon}
                      name="Ask AI"
                      data-action="ask-ai"
                      trailing={
                        <ShortcutKey shortcut={{ modifiers: ["mod"], key: "i" }} variant="medium" />
                      }
                      onClick={() => {
                        setHelpMenuOpen(false);
                        openAskAI();
                      }}
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1 p-1">
                  <SideMenuItem
                    name="Documentation"
                    icon={BookIcon}
                    trailingIcon={ArrowUpRightIcon}
                    trailingIconClassName="text-text-dimmed"
                    to="https://trigger.dev/docs"
                    data-action="documentation"
                    target="_blank"
                  />
                </div>
                <div className="flex flex-col gap-1 p-1">
                  <SideMenuItem
                    name="Status"
                    icon={RadarPulseIcon}
                    trailingIcon={ArrowUpRightIcon}
                    trailingIconClassName="text-text-dimmed"
                    to="https://status.trigger.dev/"
                    data-action="status"
                    target="_blank"
                  />
                  <SideMenuItem
                    name="Suggest a feature"
                    icon={BulbIcon}
                    trailingIcon={ArrowUpRightIcon}
                    trailingIconClassName="text-text-dimmed"
                    to="https://feedback.trigger.dev/"
                    data-action="suggest-a-feature"
                    target="_blank"
                  />
                  <Shortcuts />
                  <Feedback
                    button={
                      <SideMenuItemButton
                        icon={EnvelopeIcon}
                        name="Contact us…"
                        data-action="contact-us"
                      />
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
                      to={sanitizeHttpUrl(entry.actionUrl) ?? "https://trigger.dev/changelog"}
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
        )}
      </AskAIRoot>
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
