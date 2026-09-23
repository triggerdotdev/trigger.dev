import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";

export const NodeRuntimeDeprecationEmailSchema = z.object({
  email: z.literal("node-runtime-deprecation"),
  organization: z.string(),
  project: z.string(),
  environment: z.string(),
  version: z.string(),
  runtimeVersion: z.string(),
  deploymentLink: z.string().url(),
  projectsLink: z.string().url(),
});

type NodeRuntimeDeprecationEmailProps = z.infer<typeof NodeRuntimeDeprecationEmailSchema>;

const previewDefaults: NodeRuntimeDeprecationEmailProps = {
  email: "node-runtime-deprecation",
  organization: "My Organization",
  project: "My Project",
  environment: "production",
  version: "20260910.1",
  runtimeVersion: "21.7.3",
  deploymentLink: "https://trigger.dev",
  projectsLink: "https://trigger.dev",
};

export default function Email(props: NodeRuntimeDeprecationEmailProps) {
  const {
    organization,
    project,
    environment,
    version,
    runtimeVersion,
    deploymentLink,
    projectsLink,
  } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`${project} deployed using deprecated Node 21`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>This deployment uses deprecated Node 21</Text>
          <Text style={paragraphLight}>
            This deployment was built using Node {runtimeVersion}. From 5 October, deployments that
            would otherwise use Node 21 will start using Node 24 instead.
          </Text>
          <Text style={paragraphLight}>
            Organization: <strong>{organization}</strong>
            <br />
            Environment: <strong>{environment}</strong>
            <br />
            Project: <strong>{project}</strong>
            <br />
            Version: <strong>{version}</strong>
          </Text>
          <Link href={deploymentLink} target="_blank" style={anchor}>
            View deployment
          </Link>

          <Text style={sectionHeading}>Upgrade now</Text>
          <Text style={paragraphLight}>
            If you want to upgrade and test the change before then, edit{" "}
            <strong>trigger.config.ts</strong>, set the <strong>runtime</strong> field, and deploy
            again:
          </Text>
          <Text style={code}>{'runtime: "node-24"'}</Text>
          <Text style={{ ...paragraphLight, marginBottom: "50px" }}>
            Full instructions are available in your{" "}
            <Link href={projectsLink} target="_blank" style={anchor}>
              Projects settings
            </Link>{" "}
            and in the{" "}
            <Link
              href="https://trigger.dev/docs/config/config-file#runtime"
              target="_blank"
              style={anchor}
            >
              runtime documentation
            </Link>
            .
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}

const sectionHeading = {
  ...paragraphLight,
  fontSize: "18px",
  fontWeight: "bold",
  marginTop: "32px",
  marginBottom: "8px",
};

const code = {
  color: "#D7D9DD",
  backgroundColor: "#272A2E",
  borderRadius: "4px",
  fontFamily: "monospace",
  fontSize: "14px",
  lineHeight: "22px",
  padding: "12px 16px",
};
