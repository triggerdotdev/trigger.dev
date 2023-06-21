import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./ui/accordion";
import { Paragraph } from "./Paragraph";
import { Header4 } from "./Header";
import {
  BellAlertIcon,
  EnvelopeIcon,
  MapIcon,
} from "@heroicons/react/24/solid";

const accordianContentVariants = {
  summaryEmailCard: {
    icon: <EnvelopeIcon className="text-indigo-500" />,
    inactiveHeaderText: "Setup a weekly summary email",
    inactiveBodyText:
      "Enter your email and pick any time of the week to get a summary sent straight to your inbox.",
    activeHeaderText: "Weekly summary email",
    activeBodyText: "Scheduled for",
  },
  dailySlackSummary: {
    icon: <MapIcon className="text-yellow-500" />,
    inactiveHeaderText: "Post a daily summary to Slack",
    inactiveBodyText:
      "Connect to Slack and send a daily summary to any public channel.",
    activeHeaderText: "Daily Slack summary",
    activeBodyText: "Scheduled for",
  },
  githubIssuesSync: {
    icon: <BellAlertIcon className="text-red-500" />,
    inactiveHeaderText: "Sync GitHub issues",
    inactiveBodyText:
      "Connect to Github, select a repo and sync open GitHub issues to this list.",
    activeHeaderText: "GitHub issues are synced",
    activeBodyText: "Synced using the GitHub webhook",
  },
};

type AccordianTriggerProps = {
  className?: string;
  accordianContentVariant: keyof typeof accordianContentVariants;
  id?: string;
  active: boolean;
};

export function AccordianTriggerContent({
  active,
  accordianContentVariant,
}: AccordianTriggerProps) {
  return (
    <div>
      <div className="flex gap-2">
        <div className="w-6 h-6">
          {accordianContentVariants[accordianContentVariant].icon}
        </div>
        <div className="w-11/12">
          {" "}
          <Header4 variant={"extra-small/medium"}>
            {active ? (
              <>
                {
                  accordianContentVariants[accordianContentVariant]
                    .activeHeaderText
                }
              </>
            ) : (
              <>
                {
                  accordianContentVariants[accordianContentVariant]
                    .inactiveHeaderText
                }
              </>
            )}
          </Header4>
        </div>
      </div>
      <Paragraph variant="small">
        {active ? (
          <>
            {accordianContentVariants[accordianContentVariant].activeBodyText}
          </>
        ) : (
          <>
            {accordianContentVariants[accordianContentVariant].inactiveBodyText}
          </>
        )}
      </Paragraph>
    </div>
  );
}

type CardProps = {
  className?: string;
  children: React.ReactNode;
  active: boolean;
  accordianContentVariant: keyof typeof accordianContentVariants;
};

export function TriggerCard({
  accordianContentVariant,
  active,
  children,
}: CardProps) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="item-1">
        <AccordionTrigger className="text-left">
          <AccordianTriggerContent
            accordianContentVariant={accordianContentVariant}
            active={active}
          />
        </AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
