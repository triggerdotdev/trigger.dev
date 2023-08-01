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
  workflowId = "t35t",
}: {
  name?: string;
  workflowId: string;
}) {
  return (
    <Html>
      <Head />
      <Section style={main}>
        <Text style={paragraph}>Your workflow, {workflowId ?? "WORKFLOWID"} has failed.</Text>

        <Text style={paragraph}>To learn more, just click the button below.</Text>

        <Button href="" pX={20} pY={12} style={button}>
          View the issue
        </Button>

        <Text style={paragraph}>— The Trigger.dev team</Text>

        <Footer />
      </Section>
    </Html>
  );
}
