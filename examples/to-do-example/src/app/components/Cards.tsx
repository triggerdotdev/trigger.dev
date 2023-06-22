"use client";

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./ui/accordion";
import { Paragraph } from "./Paragraph";
import { Header4 } from "./Header";
import { CheckCircleIcon, EnvelopeIcon } from "@heroicons/react/24/solid";
import {
  SlackIcon,
  GitHubLightIcon,
  LinearLightIcon,
} from "@trigger.dev/companyicons";
import { Content } from "next/font/google";

const accordianContentVariants = {
  summaryEmailCard: {
    icon: <EnvelopeIcon className="text-indigo-500" />,
    inactiveHeaderText: "Setup a weekly summary email",
    inactiveBodyText:
      "Enter your email and pick any time of the week to get a summary sent straight to your inbox.",
    activeHeaderText: "Weekly summary email",
    activeBodyReactContent: (
      <Paragraph removeBottomPadding variant="small" className="text-semibold">
        Scheduled for
      </Paragraph>
    ),
  },
  dailySlackSummary: {
    icon: <SlackIcon className="text-yellow-500" />,
    inactiveHeaderText: "Post a daily summary to Slack",
    inactiveBodyText:
      "Connect to Slack and send a daily summary to any public channel.",
    activeHeaderText: "Daily Slack summary",
    activeBodyReactContent: "Scheduled for",
  },
  githubIssuesSync: {
    icon: <GitHubLightIcon className="text-red-500" />,
    inactiveHeaderText: "Sync GitHub issues",
    inactiveBodyText:
      "Connect to Github, select a repo and sync open GitHub issues to this list.",
    activeHeaderText: "GitHub issues are synced",
    activeBodyReactContent: "Synced using the GitHub webhook",
  },
};

type AccordianTriggerProps = {
  className?: string;
  accordianContentVariant: keyof typeof accordianContentVariants;
  id?: string;
  active: boolean;
  scheduledTime: string;
};

export function AccordianTriggerContent({
  active,
  accordianContentVariant,
  scheduledTime,
}: AccordianTriggerProps) {
  const contentVariants = accordianContentVariants[accordianContentVariant];
  return (
    <div>
      <div className="flex gap-2">
        <div className="w-6 h-6">{contentVariants.icon}</div>
        <div className="w-11/12">
          <Header4 variant={"extra-small/medium"} className="text-slate-300">
            {active
              ? contentVariants.activeHeaderText
              : contentVariants.inactiveHeaderText}
          </Header4>
        </div>
      </div>
      {active ? (
        <>
          <div className="flex gap-1 items-center">
            <CheckCircleIcon className="text-green-500 h-3 w-3" />
            {contentVariants.activeBodyReactContent}
            <Paragraph
              variant="small"
              className="font-bold text-slate-300"
              removeBottomPadding
            >
              {scheduledTime}
            </Paragraph>
          </div>
        </>
      ) : (
        <Paragraph variant="small">
          {contentVariants.inactiveBodyText}
        </Paragraph>
      )}
    </div>
  );
}

type CardProps = {
  className?: string;
  children: React.ReactNode;
  active: boolean;
  accordianContentVariant: keyof typeof accordianContentVariants;
  scheduledTime: string;
};

export function TriggerCard({
  accordianContentVariant,
  active,
  children,
  scheduledTime,
}: CardProps) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="item-1">
        <AccordionTrigger className="text-left">
          <AccordianTriggerContent
            accordianContentVariant={accordianContentVariant}
            active={active}
            scheduledTime={scheduledTime}
          />
        </AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

const SyncCardVariants = {
  linearSyncVariant: {
    icon: <LinearLightIcon />,
    inactiveHeaderText: "Sync Linear issues",
    activeHeaderText: "Linear issues are synced",
    activeBodyReactContent: (
      <Paragraph removeBottomPadding variant="small">
        Scheduled for
      </Paragraph>
    ),
    inProgressReactContent: <div>Syncing...</div>,
  },
};

type SyncCardProps = {
  className?: string;
  syncCardVariant: keyof typeof SyncCardVariants;
  active: boolean;
  scheduledTime: string;
};

export function TriggerSyncCard({
  active,
  syncCardVariant,
  scheduledTime,
}: SyncCardProps) {
  const syncVariant = SyncCardVariants[syncCardVariant];
  return (
    <>
      <div className="bg-slate-900 p-3 rounded-md  ">
        <div className="flex flex-col gap-0.5">
          <div className="flex place-content-between">
            <div className="flex gap-2">
              <div className="w-6 h-6">{syncVariant.icon}</div>
              <Header4
                variant={"extra-small/medium"}
                className="text-slate-300"
              >
                {active
                  ? syncVariant.activeHeaderText
                  : syncVariant.inactiveHeaderText}
              </Header4>
            </div>
            <div>
              {" "}
              {active ? (
                <button className="bg-slate-700 hover:bg-slate-600 transition px-2 rounded font-sans">
                  Sync now
                </button>
              ) : (
                <button className="bg-indigo-500 hover:bg-indigo-400 transition px-2 rounded font-sans">
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
        {active ? (
          <>
            <div className="flex gap-1 items-center">
              <CheckCircleIcon className="text-green-500 h-3 w-3" />
              syncVariant.activeBodyReactContent
              <Paragraph
                variant="small"
                className="font-bold text-slate-300"
                removeBottomPadding
              >
                {scheduledTime}
              </Paragraph>
            </div>
          </>
        ) : (
          <>{}</>
        )}
      </div>
    </>
  );
}
