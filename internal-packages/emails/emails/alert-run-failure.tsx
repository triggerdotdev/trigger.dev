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
import { anchor, container, h1, main, paragraphLight, paragraphTight } from "./components/styles";
import React from "react";

export const AlertRunEmailSchema = z.object({
  email: z.literal("alert-run"),
  runId: z.string(),
  project: z.string(),
  taskIdentifier: z.string(),
  fileName: z.string(),
  version: z.string(),
  environment: z.string(),
  error: z.object({
    message: z.string(),
    name: z.string().optional(),
    stackTrace: z.string().optional(),
  }),
  runLink: z.string().url(),
  organization: z.string(),
});

type AlertRunEmailProps = z.infer<typeof AlertRunEmailSchema>;

const previewDefaults: AlertRunEmailProps = {
  email: "alert-run",
  runId: "run_12345678",
  project: "my-project",
  taskIdentifier: "my-task",
  fileName: "other.ts",
  version: "20240101.1",
  environment: "prod",
  error: {
    message: "Error message",
    name: "Error name",
    stackTrace: "Error stack trace",
  },
  runLink: "https://trigger.dev",
  organization: "my-organization",
};

export default function Email(props: AlertRunEmailProps) {
  const {
    runId,
    project,
    taskIdentifier,
    fileName,
    version,
    environment,
    error,
    runLink,
    organization,
  } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`${organization}: [${version}.${environment} ${taskIdentifier}] ${error.message}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Run `{runId}` failed</Text>
          <Text style={paragraphTight}>Organization: {organization}</Text>
          <Text style={paragraphTight}>Project: {project}</Text>
          <Text style={paragraphTight}>Task ID: {taskIdentifier}</Text>
          <Text style={paragraphTight}>Filename: {fileName}</Text>
          <Text style={paragraphTight}>Version: {version}</Text>
          <Text style={paragraphTight}>Environment: {environment}</Text>

          <Text style={paragraphLight}>{error.message}</Text>
          {error.stackTrace && (
            <CodeBlock code={error.stackTrace} theme={dracula} lineNumbers language="log" />
          )}
          <Link
            href={runLink}
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
