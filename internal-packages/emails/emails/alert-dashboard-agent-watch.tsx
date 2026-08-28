import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import React from "react";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { footerAnchor, footerItalic } from "./components/styles";

export const AlertDashboardAgentWatchEmailSchema = z.object({
  email: z.literal("alert-dashboard-agent-watch"),
  /** The watched condition, as the agent names it (e.g. `run_finished:run_abc`). */
  identity: z.string(),
  /** The watch kind, e.g. `run_finished`. */
  kind: z.string(),
  /** Rendered by the webapp's `watch-presentation.ts`. Optional so an older enqueue still renders. */
  headline: z.string().optional(),
  /** Colours the accent only. */
  tone: z.enum(["success", "warning", "error", "neutral"]).optional(),
  /** Why the watch exists, in the user's own words. */
  note: z.string(),
  /**
   * The sentence that quotes the note, rendered by the webapp's presenter so this
   * email and the Slack message say it identically. Optional so an older enqueue
   * still renders.
   */
  noteLine: z.string().optional(),
  firedAt: z.string(),
  /** What the check observed, already flattened to label/value pairs. */
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  dashboardLink: z.string().url(),
  unsubscribeLink: z.string().url().optional(),
  organization: z.string(),
  project: z.string(),
  environment: z.string(),
});

type AlertDashboardAgentWatchEmailProps = z.infer<typeof AlertDashboardAgentWatchEmailSchema>;

const previewDefaults: AlertDashboardAgentWatchEmailProps = {
  email: "alert-dashboard-agent-watch",
  identity: "run_finished:run_abc123",
  kind: "run_finished",
  headline: "Run run_abc123 finished",
  tone: "success",
  note: "tell me when the nightly invoice run finishes",
  noteLine: "You asked to be told when: tell me when the nightly invoice run finishes",
  firedAt: "2026-07-29T12:00:00.000Z",
  facts: [
    { label: "Status", value: "COMPLETED" },
    { label: "Duration", value: "4.2s" },
  ],
  dashboardLink: "https://cloud.trigger.dev",
  unsubscribeLink: "https://cloud.trigger.dev/unsubscribe",
  organization: "my-organization",
  project: "my-project",
  environment: "Production",
};

function formatFiredAt(firedAt: string) {
  const date = new Date(firedAt);

  if (Number.isNaN(date.getTime())) {
    return firedAt;
  }

  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Only the accent colour is chosen here: the headline and note line arrive already rendered.
const TONE_COLOR: Record<string, string> = {
  success: "#A8FF53",
  warning: "#FBBF24",
  error: "#F87171",
  neutral: "#D7D9DD",
};

/** Fallback for a payload enqueued before `headline` existed. */
function fallbackHeadline(identity: string): string {
  return `Your watch has an answer — ${identity}`;
}

export default function Email(props: AlertDashboardAgentWatchEmailProps) {
  const {
    identity,
    headline,
    tone,
    note,
    noteLine,
    firedAt,
    facts,
    dashboardLink,
    unsubscribeLink,
    organization,
    project,
    environment,
  } = { ...previewDefaults, ...props };

  const details = [identity, ...facts.slice(0, 3).map((fact) => `${fact.label}: ${fact.value}`)];
  const accentColor = TONE_COLOR[tone ?? "neutral"] ?? TONE_COLOR.neutral;

  return (
    <Html>
      <Head />
      <Preview>{`${organization}: ${headline ?? fallbackHeadline(identity)}`}</Preview>
      <Tailwind>
        <Body className="bg-[#15171A] my-auto mx-auto font-sans">
          <Container className="my-[40px] mx-auto p-[20px] max-w-[600px]">
            <Section className="mt-[32px]">
              <Image
                path="/emails/logo-mono.png"
                width="120"
                height="22"
                alt="Trigger.dev"
                className="my-0"
              />
            </Section>
            <Section>
              {/* Fact first, as in the panel: the micro-label says it's a watch, the
                  headline carries the fact. */}
              <Text
                className="text-[11px] uppercase tracking-widest m-0"
                style={{ color: accentColor }}
              >
                Watch update
              </Text>
              <Heading className="text-[#D7D9DD] text-[30px] font-normal leading-[35px] p-0 mt-[8px] mb-[30px] mx-0">
                {headline ?? fallbackHeadline(identity)}
              </Heading>
              <Text className="text-[#D7D9DD] text-[16px] leading-[24px]">
                I was keeping an eye on {project} ({environment}) for you, and this is the answer,
                as of {formatFiredAt(firedAt)}. {noteLine ?? `You asked to be told when: ${note}`}
              </Text>
              <Text className="text-[#878C99] text-[14px] leading-[20px]">
                {details.join(" · ")}
              </Text>
            </Section>
            <Section className="mt-[32px] mb-[32px]">
              <Button
                href={dashboardLink}
                className="bg-[#A8FF53] rounded text-[#121317] text-[16px] no-underline text-center px-4 py-3"
              >
                Open the dashboard
              </Button>
            </Section>

            {unsubscribeLink && (
              <Text style={footerItalic}>
                <Link href={unsubscribeLink} target="_blank" style={footerAnchor}>
                  Turn off these alerts
                </Link>
              </Text>
            )}

            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
