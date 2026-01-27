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
              "group flex h-8 items-center gap-1.5 rounded pl-[0.4375rem] pr-2 transition-colors hover:bg-charcoal-750",
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
            <SideMenuItem
              name="Changelog"
              icon={StarIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-sun-500"
              activeIconColor="text-sun-500"
              to="https://trigger.dev/changelog"
              data-action="changelog"
              target="_blank"
            />
            <Shortcuts />
          </div>
          <div className="flex flex-col gap-1 p-1">
            <Paragraph className="pb-1 pl-1.5 pt-1.5 text-xs">Need help?</Paragraph>
            {currentPlan?.v3Subscription?.plan?.limits.support === "slack" && (
              <div>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="small-menu-item"
                      LeadingIcon={SlackIcon}
                      data-action="join-our-slack"
                      fullWidth
                      textAlignLeft
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="text-text-bright">Join our Slack…</span>
                        <Badge variant="extra-small" className="uppercase">
                          Pro
                        </Badge>
                      </div>
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>Join our Slack</DialogHeader>
                    <div className="mt-2 flex flex-col gap-4">
                      <div className="flex items-center gap-4">
                        <Icon icon={SlackIcon} className="h-10 w-10 min-w-[2.5rem]" />
                        <Paragraph variant="base/bright">
                          As a subscriber, you have access to a dedicated Slack channel for 1-to-1
                          support with the Trigger.dev team.
                        </Paragraph>
                      </div>
                      <hr className="border-charcoal-800" />
                      <div>
                        <StepNumber stepNumber="1" title="Email us" />
                        <StepContentContainer>
                          <Paragraph>
                            Send us an email to this address from your Trigger.dev account email
                            address:
                            <ClipboardField
                              variant="secondary/medium"
                              value="priority-support@trigger.dev"
                              className="my-2"
                            />
                          </Paragraph>
                        </StepContentContainer>
                        <StepNumber stepNumber="2" title="Look out for an invite from Slack" />
                        <StepContentContainer>
                          <Paragraph>
                            As soon as we can, we'll setup a Slack Connect channel and say hello!
                          </Paragraph>
                        </StepContentContainer>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            )}
            <SideMenuItem
              name="Ask in our Discord"
              icon={DiscordIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              to="https://trigger.dev/discord"
              data-action="join our discord"
              target="_blank"
            />
            <SideMenuItem
              name="Book a 15 min call"
              icon={CalendarDaysIcon}
              trailingIcon={ArrowUpRightIcon}
              trailingIconClassName="text-text-dimmed"
              inactiveIconColor="text-rose-500"
              activeIconColor="text-rose-500"
              to="https://cal.com/team/triggerdotdev/founders-call"
              data-action="book-a-call"
              target="_blank"
            />
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
        </Fragment>
      </PopoverContent>
      </Popover>
    </motion.div>
  );
}
