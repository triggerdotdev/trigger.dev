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
import { DiscordIcon, SlackIcon } from "@trigger.dev/companyicons";
import { Fragment, useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { Feedback } from "../Feedback";
import { Shortcuts } from "../Shortcuts";
import { StepContentContainer } from "../StepContentContainer";
import { Button } from "../primitives/Buttons";
import { ClipboardField } from "../primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverSideMenuTrigger } from "../primitives/Popover";
import { StepNumber } from "../primitives/StepNumber";
import { SideMenuItem } from "./SideMenuItem";
import { Badge } from "../primitives/Badge";

export function HelpAndFeedback({ disableShortcut = false }: { disableShortcut?: boolean }) {
  const [isHelpMenuOpen, setHelpMenuOpen] = useState(false);
  const currentPlan = useCurrentPlan();

  return (
    <Popover onOpenChange={(open) => setHelpMenuOpen(open)}>
      <PopoverSideMenuTrigger
        isOpen={isHelpMenuOpen}
        shortcut={{ key: "h", enabledOnInputElements: false }}
        className="grow pr-2"
        disabled={disableShortcut}
      >
        <div className="flex items-center gap-1.5">
          <QuestionMarkCircleIcon className="size-4 text-success" />
          Help & Feedback
        </div>
      </PopoverSideMenuTrigger>
      <PopoverContent
        className="min-w-[14rem] divide-y divide-grid-bright overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
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
                  LeadingIcon={EnvelopeIcon}
                  leadingIconClassName="text-blue-500"
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
  );
}
