import {
  Body,
  CodeBlock,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Text,
  dracula,
} from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";

export const AlertDeploymentFailureEmailSchema = z.object({
  email: z.literal("alert-deployment-failure"),
  version: z.string(),
  environment: z.string(),
  organization: z.string(),
  shortCode: z.string(),
  failedAt: z.date(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  deploymentLink: z.string().url(),
});

const previewDefaults = {
  version: "v1",
  environment: "production",
  organization: "My Organization",
  shortCode: "abc123",
  failedAt: new Date().toISOString(),
  error: {
    name: "Error",
    stack: "Error: Something went wrong\n    at main.ts:12:34",
  },
  deploymentLink: "https://trigger.dev",
};

export default function Email(props: z.infer<typeof AlertDeploymentFailureEmailSchema>) {
  const { version, environment, organization, shortCode, failedAt, error, deploymentLink } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`[${organization}] Deployment ${version} [${environment}] failed: ${error.name}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text
            style={h1}
          >{`An error occurred deploying ${version} in ${environment} in your ${organization} organization`}</Text>
          <Text style={paragraphLight}>
            {error.name} {error.message}
          </Text>
          {error.stack && (
            <CodeBlock code={error.stack} theme={dracula} lineNumbers language="log" />
          )}
          <Link
            href={deploymentLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "50px",
            }}
          >
            Investigate this error
          </Link>

          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
