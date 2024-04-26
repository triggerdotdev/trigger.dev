import { CodeBlock, dracula } from "@react-email/code-block";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Html } from "@react-email/html";
import { Link } from "@react-email/link";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import * as React from "react";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main } from "./components/styles";

export const AlertDeploymentSuccessEmailSchema = z.object({
  email: z.literal("alert-deployment-success"),
  version: z.string(),
  environment: z.string(),
  shortCode: z.string(),
  deployedAt: z.date(),
  taskCount: z.number(),
  deploymentLink: z.string().url(),
});

const previewDefaults = {
  version: "v1",
  environment: "production",
  shortCode: "abc123",
  deployedAt: new Date().toISOString(),
  taskCount: 3,
  deploymentLink: "https://trigger.dev",
};

export default function Email(props: z.infer<typeof AlertDeploymentSuccessEmailSchema>) {
  const { version, environment, shortCode, deployedAt, taskCount, deploymentLink } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`Deployment ${version} [${environment}] succeeded`}</Preview>
      <Section style={main}>
        <Container style={container}>
          <Text
            style={h1}
          >{`Version ${version} successfully deployed ${taskCount} tasks in ${environment}.`}</Text>

          <Link
            href={deploymentLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "16px",
            }}
          >
            View Deployment
          </Link>

          <Image path="/emails/logo-mono.png" width="156" height="28" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Section>
    </Html>
  );
}
