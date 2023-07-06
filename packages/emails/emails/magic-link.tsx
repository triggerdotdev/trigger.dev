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

export default function Email({ magicLink }: { magicLink: string }) {
  return (
    <Html>
      <Head />
      <Preview>Log in with this magic link 🪄</Preview>
      <Section style={main}>
        <Container style={container}>
          <Text style={h1}>Log in to Trigger.dev</Text>
          <Link
            href={magicLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "16px",
            }}
          >
            Click here to log in with this magic link
          </Link>
          <Text style={paragraphLight}>
            If you didn&apos;t try to log in, you can safely ignore this email.
          </Text>
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
