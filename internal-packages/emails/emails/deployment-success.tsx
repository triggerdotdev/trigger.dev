import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main } from "./components/styles";

export const AlertDeploymentSuccessEmailSchema = z.object({
  email: z.literal("alert-deployment-success"),
  version: z.string(),
  environment: z.string(),
  organization: z.string(),
  shortCode: z.string(),
  deployedAt: z.date(),
  taskCount: z.number(),
  deploymentLink: z.string().url(),
});

const previewDefaults = {
  version: "v1",
  environment: "production",
  organization: "My Organization",
  shortCode: "abc123",
  deployedAt: new Date().toISOString(),
  taskCount: 3,
  deploymentLink: "https://trigger.dev",
};

export default function Email(props: z.infer<typeof AlertDeploymentSuccessEmailSchema>) {
  const { version, environment, organization, shortCode, deployedAt, taskCount, deploymentLink } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`[${organization}] Deployment ${version} [${environment}] succeeded`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text
            style={h1}
          >{`Version ${version} successfully deployed ${taskCount} tasks in ${environment} in your ${organization} organization`}</Text>

          <Link
            href={deploymentLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "50px",
            }}
          >
            View Deployment
          </Link>

          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
