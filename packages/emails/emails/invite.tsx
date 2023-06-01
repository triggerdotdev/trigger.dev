import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Image } from "./components/Image";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { Footer } from "./components/Footer";
import {
  main,
  anchor,
  h1,
  container,
  paragraphLight,
} from "./components/styles";
import { z } from "zod";

export const InviteEmailSchema = z.object({
  email: z.literal("invite"),
  orgName: z.string(),
  inviterName: z.string().optional(),
  inviterEmail: z.string(),
  inviteLink: z.string().url(),
});

export default function Email({
  orgName,
  inviterName,
  inviterEmail,
  inviteLink,
}: z.infer<typeof InviteEmailSchema>) {
  return (
    <Html>
      <Head />
      <Preview>{`You've been invited to ${orgName}`}</Preview>
      <Section style={main}>
        <Container style={container}>
          <Text style={h1}>{`You've been invited to ${orgName}`}</Text>
          <Text style={paragraphLight}>
            {inviterName ?? inviterEmail} has invited you to join their
            organization on Trigger.dev.
          </Text>
          <Link
            href={inviteLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "16px",
            }}
          >
            Click here to view the invitation
          </Link>

          <Image
            path="/emails/logo-mono.png"
            width="156"
            height="28"
            alt="Trigger.dev"
          />
          <Footer />
        </Container>
      </Section>
    </Html>
  );
}
