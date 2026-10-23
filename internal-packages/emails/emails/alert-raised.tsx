import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import React from "react";
import { z } from "zod";
import {
  ALERT_RAISED_BUTTON_TEXT,
  ALERT_RAISED_LABEL,
  alertRaisedSentence,
} from "../src/alertRaisedContent";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";

export const AlertRaisedEmailSchema = z.object({
  email: z.literal("alert-raised"),
  alertName: z.string(),
  capabilityKey: z.string(),
  headline: z.string(),
  raisedAt: z.string(),
  detail: z.string().nullish(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  dashboardLink: z.string().url(),
  organization: z.string(),
  project: z.string(),
  environment: z.string(),
});

type AlertRaisedEmailProps = z.infer<typeof AlertRaisedEmailSchema>;

const previewDefaults: AlertRaisedEmailProps = {
  email: "alert-raised",
  alertName: "Queue depth > 100",
  capabilityKey: "queue.depth",
  headline: "Alert raised: Queue depth > 100",
  raisedAt: "2026-09-17T12:00:00.000Z",
  facts: [
    { label: "Queue depth", value: "142" },
    { label: "Threshold", value: "100" },
  ],
  dashboardLink: "https://cloud.trigger.dev",
  organization: "my-organization",
  project: "my-project",
  environment: "Production",
};

export default function Email(props: AlertRaisedEmailProps) {
  const {
    alertName,
    headline,
    raisedAt,
    detail,
    dashboardLink,
    organization,
    project,
    environment,
  } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`[${organization}] ${headline}`}</Preview>
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
              <Text className="text-[11px] uppercase tracking-widest m-0 text-[#F87171]">
                {ALERT_RAISED_LABEL}
              </Text>
              <Heading className="text-[#D7D9DD] text-[30px] font-normal leading-[35px] p-0 mt-[8px] mb-[30px] mx-0">
                {headline}
              </Heading>
              <Text className="text-[#D7D9DD] text-[16px] leading-[24px]">
                {alertRaisedSentence({ alertName, project, environment, raisedAt })}
              </Text>
              {detail
                ? detail.split("\n").map((line, i) => (
                    <Text key={i} className="text-[#D7D9DD] text-[16px] leading-[24px] my-0">
                      {line}
                    </Text>
                  ))
                : null}
            </Section>
            <Section className="mt-[32px] mb-[32px]">
              <Button
                href={dashboardLink}
                className="bg-[#A8FF53] rounded text-[#121317] text-[16px] no-underline text-center px-4 py-3"
              >
                {ALERT_RAISED_BUTTON_TEXT}
              </Button>
            </Section>
            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
