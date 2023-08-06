import { Button } from "@react-email/button";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { Footer } from "./components/Footer";
import { main, paragraph, button } from "./components/styles";

export default function Email({
  name,
  integration = "Slack",
  workflowId = "t35t",
}: {
  name?: string;
  workflowId: string;
  integration: string;
}) {
  return (
    <Html>
      <Head />
      <Section style={main}>
        <Text style={paragraph}>
          Your workflow {workflowId ?? "WORKFLOWID"} can’t run because it requires{" "}
          {integration ?? "INTEGRATION"} to be connected.
        </Text>

        <Text style={paragraph}>To get back up and running, just click the button below.</Text>

        <Button href="" pX={20} pY={12} style={button}>
          Connect {integration ?? "INTEGRATION"}
        </Button>

        <Text style={paragraph}>— The Trigger.dev team</Text>

        <Footer />
      </Section>
    </Html>
  );
}
