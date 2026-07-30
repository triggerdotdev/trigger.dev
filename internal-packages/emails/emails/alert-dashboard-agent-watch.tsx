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
  /** Why the watch exists, in the user's own words. */
  note: z.string(),
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
  note: "tell me when the nightly invoice run finishes",
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

/** ISO timestamps read badly in prose, so shorten to `2026-07-29 12:00 UTC`. */
function formatFiredAt(firedAt: string) {
  const date = new Date(firedAt);

  if (Number.isNaN(date.getTime())) {
    return firedAt;
  }

  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The chat's wake banner, in email form. Same tone mapping as the panel's
 * WakeBanner: a fired good-news kind is "all clear", a recurred error "needs
 * your attention", anything else states the fact.
 */
const GOOD_NEWS_KINDS = new Set(["health_recovery", "backlog_drain", "run_start", "run_finished"]);

function outcomeLine(kind: string): { accent: string; color: string } {
  if (GOOD_NEWS_KINDS.has(kind)) return { accent: "all clear", color: "#A8FF53" };
  if (kind === "error_recurrence") return { accent: "needs your attention", color: "#F87171" };
  return { accent: "condition met", color: "#D7D9DD" };
}

export default function Email(props: AlertDashboardAgentWatchEmailProps) {
  const {
    identity,
    kind,
    note,
    firedAt,
    facts,
    dashboardLink,
    unsubscribeLink,
    organization,
    project,
    environment,
  } = { ...previewDefaults, ...props };

  const details = [identity, ...facts.slice(0, 3).map((fact) => `${fact.label}: ${fact.value}`)];
  const outcome = outcomeLine(kind);

  return (
    <Html>
      <Head />
      <Preview>{`${organization}: your watch fired — ${identity}`}</Preview>
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
              {/* The chat's wake banner IS the headline: the outcome first,
                  toned — the details line below carries the watch identity. */}
              <Heading className="text-[#D7D9DD] text-[30px] font-normal leading-[35px] p-0 my-[30px] mx-0">
                Watch update — <strong style={{ color: outcome.color }}>{outcome.accent}</strong>
              </Heading>
              <Text className="text-[#D7D9DD] text-[16px] leading-[24px]">
                I was keeping an eye on {project} ({environment}) for you, and this just fired at{" "}
                {formatFiredAt(firedAt)}. Your note on this watch: “{note}”.
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
