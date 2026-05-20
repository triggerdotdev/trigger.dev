import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Row,
  Text,
} from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, bullets, container, grey, h1, main } from "./components/styles";

export const AlertDeploymentSuccessEmailSchema = z.object({
  email: z.literal("alert-deployment-success"),
  version: z.string(),
  environment: z.string(),
  organization: z.string(),
  shortCode: z.string(),
  deployedAt: z.date(),
  taskCount: z.number(),
  deploymentLink: z.string().url(),
  git: z
    .object({
      branchName: z.string(),
      shortSha: z.string(),
      commitMessage: z.string(),
      commitUrl: z.string(),
      branchUrl: z.string(),
      pullRequestNumber: z.number().optional(),
      pullRequestTitle: z.string().optional(),
      pullRequestUrl: z.string().optional(),
    })
    .optional(),
  vercelDeploymentUrl: z.string().url().optional(),
});

const previewDefaults = {
  version: "v1",
  environment: "production",
  organization: "My Organization",
  shortCode: "abc123",
  deployedAt: new Date().toISOString(),
  taskCount: 3,
  deploymentLink: "https://trigger.dev",
  git: {
    branchName: "feat/new-feature",
    shortSha: "abc1234",
    commitMessage: "Add new background task for processing uploads",
    commitUrl: "https://github.com/acme/app/commit/abc1234",
    branchUrl: "https://github.com/acme/app/tree/feat/new-feature",
    pullRequestNumber: 42,
    pullRequestTitle: "Add upload processing",
    pullRequestUrl: "https://github.com/acme/app/pull/42",
  },
  vercelDeploymentUrl: "https://vercel.com/acme/app/abc1234",
};

export default function Email(props: z.infer<typeof AlertDeploymentSuccessEmailSchema>) {
  const {
    version,
    environment,
    organization,
    shortCode,
    deployedAt,
    taskCount,
    deploymentLink,
    git,
    vercelDeploymentUrl,
  } = {
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

          {git && (
            <>
              <Row>
                <Column style={{ ...bullets, width: "33%" }}>Branch</Column>
                <Column style={{ ...bullets, ...grey, width: "66%" }}>
                  <Link href={git.branchUrl} style={anchor}>
                    {git.branchName}
                  </Link>
                </Column>
              </Row>
              <Row>
                <Column style={{ ...bullets, width: "33%" }}>Commit</Column>
                <Column style={{ ...bullets, ...grey, width: "66%" }}>
                  <Link href={git.commitUrl} style={anchor}>
                    {git.shortSha}
                  </Link>{" "}
                  {git.commitMessage}
                </Column>
              </Row>
              {git.pullRequestNumber && git.pullRequestUrl && (
                <Row>
                  <Column style={{ ...bullets, width: "33%" }}>Pull Request</Column>
                  <Column style={{ ...bullets, ...grey, width: "66%" }}>
                    <Link href={git.pullRequestUrl} style={anchor}>
                      #{git.pullRequestNumber}
                    </Link>
                    {git.pullRequestTitle ? ` ${git.pullRequestTitle}` : ""}
                  </Column>
                </Row>
              )}
            </>
          )}
          {vercelDeploymentUrl && (
            <Row>
              <Column style={{ ...bullets, width: "33%" }}>Vercel</Column>
              <Column style={{ ...bullets, ...grey, width: "66%" }}>
                <Link href={vercelDeploymentUrl} style={anchor}>
                  View Vercel Deployment
                </Link>
              </Column>
            </Row>
          )}

          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
