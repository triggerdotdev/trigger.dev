import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Hr } from "@react-email/hr";
import { Html } from "@react-email/html";
import { Image } from "./components/Image";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";

export default function Email({ name }: { name?: string }) {
  return (
    <Html>
      <Head />
      <Preview>You're now ready to make live transactions with Stripe!</Preview>
      <Section style={main}>
        <Text style={paragraph}>Hey {name ?? "there"},</Text>
        <Text style={paragraph}>
          Thanks for signing up! I’m Matt, CEO of Trigger.dev.
        </Text>
        <Text style={paragraph}>
          Our goal is to give developers like you the ability to easily create
          much more powerful workflows, directly from your codebase. Creating
          complex workflows should feel the same as any other important part of
          the product, which is why we created Trigger.dev.
        </Text>

        <Text style={paragraph}>
          If you’re ready - you can{" "}
          <Link style={anchor} href="https://app.trigger.dev/">
            create a new workflow.
          </Link>{" "}
        </Text>

        <Text style={paragraph}>Otherwise, please feel free to check out:</Text>

        <Text style={paragraph}>
          • Our{" "}
          <Link style={anchor} href="">
            quickstart guide
          </Link>{" "}
        </Text>

        <Text style={paragraph}>
          • Browse our{" "}
          <Link style={anchor} href="">
            workflow templates
          </Link>{" "}
          if you want some inspiration.
        </Text>

        <Text style={paragraph}>
          • Explore our{" "}
          <Link style={anchor} href="https://docs.trigger.dev/">
            docs
          </Link>{" "}
          for a full overview of the product and it’s features{" "}
        </Text>

        <Text style={paragraph}>
          •{" "}
          <Link style={anchor} href="https://docs.trigger.dev/quickstart">
            Schedule a call with us
          </Link>{" "}
          about a workflow idea you have.
        </Text>

        <Text style={paragraph}>Best,</Text>
        <Text style={paragraph}>Matt</Text>
        <Text style={paragraph}>CEO, Trigger.dev</Text>

        <Hr style={hr} />
        <Text style={footer}>
          <Link style={anchor} href="https://app.trigger.dev/">
            Trigger.dev
          </Link>
          . ©API Hero Ltd, 3rd Floor, 1 Ashley Road, Altrincham, Cheshire, WA14
          2DT
        </Text>
      </Section>
    </Html>
  );
}

const main = {
  backgroundColor: "#f6f9fc",
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "20px 0 48px",
  marginBottom: "64px",
};

const box = {
  padding: "0 48px",
};

const hr = {
  borderColor: "#e6ebf1",
  margin: "20px 0",
};

const paragraph = {
  color: "#525f7f",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left" as const,
};

const anchor = {
  color: "#556cd6",
};

const button = {
  backgroundColor: "#656ee8",
  borderRadius: "5px",
  color: "#fff",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "16px",
  fontWeight: "bold",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "block",
  width: "100%",
};

const footer = {
  color: "#8898aa",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "12px",
  lineHeight: "16px",
};
