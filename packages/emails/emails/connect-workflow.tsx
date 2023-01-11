import { Button } from "@react-email/button";
import { Head } from "@react-email/head";
import { Hr } from "@react-email/hr";
import { Html } from "@react-email/html";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";

export default function Email({
  name,
  integration,
  workflowId,
}: {
  name?: string;
  workflowId: string;
  integration: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>You need to connect your workflow!</Preview>
      <Section style={main}>
        <Text style={paragraph}>Hey {name ?? "there"},</Text>

        <Text style={paragraph}>
          Your workflow {workflowId ?? "WORKFLOWID"} can’t run because you need
          to connect to {integration ?? "INTEGRATION"}.
        </Text>

        <Text style={paragraph}>To fix this click the button below.</Text>

        <Button href="" pX={20} pY={12} style={btn}>
          Connect {integration ?? "INTEGRATION"}
        </Button>

        <Text style={paragraph}>— Trigger.dev team</Text>

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
  backgroundColor: "#ffffff",
};

const btn = {
  backgroundColor: "#3B31C3",
  borderRadius: "5px",
  color: "#fff",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: "50px",
  textDecoration: "none",
  textAlign: "center" as const,
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
  color: "#333",
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
  fontSize: "16px",
  lineHeight: "24px",
  textAlign: "left" as const,
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

const anchor = {
  color: "#556cd6",
  textDecoration: "underline",
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
