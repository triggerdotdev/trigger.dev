import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import React from "react";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import {
  anchor,
  container,
  footerItalic,
  h1,
  main,
  paragraphLight,
  paragraphTight,
} from "./components/styles";

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

  return (
    <Html>
      <Head />
      <Preview>{`${organization}: your watch fired — ${identity}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Your watch fired: {identity}</Text>

          <Text style={paragraphLight}>You asked to be told when: {note}</Text>

          <Text style={paragraphTight}>Organization: {organization}</Text>
          <Text style={paragraphTight}>Project: {project}</Text>
          <Text style={paragraphTight}>Environment: {environment}</Text>
          <Text style={paragraphTight}>Watching: {kind}</Text>
          <Text style={paragraphTight}>Fired at: {firedAt}</Text>

          {facts.map((fact) => (
            <Text key={fact.label} style={paragraphTight}>
              {fact.label}: {fact.value}
            </Text>
          ))}

          <Link
            href={dashboardLink}
            target="_blank"
            style={{ ...anchor, display: "block", marginBottom: "50px" }}
          >
            Open the dashboard
          </Link>

          {unsubscribeLink && (
            <Text style={footerItalic}>
              <Link href={unsubscribeLink} target="_blank">
                Turn off these alerts
              </Link>
            </Text>
          )}

          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
