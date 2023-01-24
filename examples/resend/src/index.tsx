import { Trigger, customEvent } from "@trigger.dev/sdk";
import { resend } from "@trigger.dev/integrations";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { Img } from "@react-email/img";
import * as React from "react";
import { z } from "zod";

new Trigger({
  id: "resend",
  name: "Resend text/html",
  apiKey: "trigger_development_YpG7UQygbuT3",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "send.email",
    schema: z.object({
      from: z.string(),
      to: z.union([z.string(), z.array(z.string())]),
      bcc: z.union([z.string(), z.array(z.string())]).optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      replyTo: z.union([z.string(), z.array(z.string())]).optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
    }),
  }),
  run: async (event, ctx) => {
    const response = await resend.sendEmail("text-email", {
      to: event.to,
      from: event.from,
      cc: event.cc,
      bcc: event.bcc,
      replyTo: event.replyTo,
      subject: event.subject,
      text: event.text,
      html: event.html,
    });

    return response;
  },
}).listen();

new Trigger({
  id: "resend-react",
  name: "Resend React",
  apiKey: "trigger_development_YpG7UQygbuT3",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "send.email",
    schema: z.object({
      from: z.string(),
      to: z.union([z.string(), z.array(z.string())]),
      bcc: z.union([z.string(), z.array(z.string())]).optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      replyTo: z.union([z.string(), z.array(z.string())]).optional(),
      subject: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
  run: async (event, ctx) => {
    const response = await resend.sendEmail("text-email", {
      to: event.to,
      from: event.from,
      cc: event.cc,
      bcc: event.bcc,
      replyTo: event.replyTo,
      subject: event.subject,
      react: <TestEmail name={event.name} />,
    });

    return response;
  },
}).listen();

const main = {
  backgroundColor: "#ffffff",
};

const bullets = {
  color: "#333",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left" as const,
  margin: "0",
};

const paragraph = {
  color: "#333",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left" as const,
};

const anchor = {
  color: "#2754C5",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
  fontSize: "16px",
  textDecoration: "underline",
};

export function TestEmail({ name }: { name?: string }) {
  return (
    <Html>
      <Head />
      <Preview>You're now ready to create complex workflows in code!</Preview>
      <Section style={main}>
        <Text style={paragraph}>Hey {name ?? "there"},</Text>
        <Text style={paragraph}>
          I’m Matt, CEO of{" "}
          <Link style={anchor} href="https://app.trigger.dev/">
            Trigger.dev
          </Link>
          .
        </Text>
        <Text style={paragraph}>
          Our goal is to give developers like you the ability to easily create
          much more powerful workflows, directly from your codebase. Creating
          complex workflows should be the same as creating any other important
          part of your product, which is why we created Trigger.dev.
        </Text>
        <Img
          src="https://via.placeholder.com/150"
          width="150px"
          height="150px"
        />

        <Text style={paragraph}>
          If you’re ready - you can{" "}
          <Link style={anchor} href="https://app.trigger.dev/">
            create a new workflow.
          </Link>{" "}
        </Text>

        <Text style={paragraph}>Otherwise, please feel free to check out:</Text>

        <Text style={bullets}>
          • Our{" "}
          <Link style={anchor} href="https://docs.trigger.dev/getting-started">
            quickstart guide
          </Link>{" "}
          to get you up and running in minutes
        </Text>
        {/* 
        <Text style={bullets}>
          • Browse our pre-built{" "}
          <Link style={anchor} href="">
            workflow templates
          </Link>{" "}
          if you want some inspiration.
        </Text> */}

        <Text style={bullets}>
          • Explore our{" "}
          <Link style={anchor} href="https://docs.trigger.dev/">
            docs
          </Link>{" "}
          for a full overview of the product and it’s features{" "}
        </Text>

        <Text style={bullets}>
          •{" "}
          <Link style={anchor} href="https://cal.com/team/triggerdotdev/call">
            Schedule a call with us
          </Link>{" "}
          about a workflow idea you have.
        </Text>

        <Text style={paragraph}>
          Feel free to drop me a message if you have any further questions!
        </Text>
        <Text style={bullets}>Best,</Text>
        <Text style={bullets}>Matt</Text>
        <Text style={paragraph}>CEO, Trigger.dev</Text>
      </Section>
    </Html>
  );
}
