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

export const AlertErrorGroupEmailSchema = z.object({
  email: z.literal("alert-error-group"),
  classification: z.enum(["new_issue", "regression", "unignored"]),
  taskIdentifier: z.string(),
  environment: z.string(),
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    stackTrace: z.string().optional(),
  }),
  occurrenceCount: z.number(),
  errorLink: z.string().url(),
  organization: z.string(),
  project: z.string(),
});

type AlertErrorGroupEmailProps = z.infer<typeof AlertErrorGroupEmailSchema>;

const classificationLabels: Record<string, string> = {
  new_issue: "New error",
  regression: "Regression",
  unignored: "Error resurfaced",
};

const previewDefaults: AlertErrorGroupEmailProps = {
  email: "alert-error-group",
  classification: "new_issue",
  taskIdentifier: "my-task",
  environment: "Production",
  error: {
    message: "Cannot read property 'foo' of undefined",
    type: "TypeError",
    stackTrace: "TypeError: Cannot read property 'foo' of undefined\n    at Object.<anonymous>",
  },
  occurrenceCount: 42,
  errorLink: "https://trigger.dev",
  organization: "my-organization",
  project: "my-project",
};

export default function Email(props: AlertErrorGroupEmailProps) {
  const {
    classification,
    taskIdentifier,
    environment,
    error,
    occurrenceCount,
    errorLink,
    organization,
    project,
  } = {
    ...previewDefaults,
    ...props,
  };

  const label = classificationLabels[classification] ?? "Error alert";

  return (
    <Html>
      <Head />
      <Preview>
        {`${organization}: [${label}] ${error.type ?? "Error"} in ${taskIdentifier} (${environment})`}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>
            {label}: {error.type ?? "Error"} in {taskIdentifier}
          </Text>
          <Text style={paragraphTight}>Organization: {organization}</Text>
          <Text style={paragraphTight}>Project: {project}</Text>
          <Text style={paragraphTight}>Task: {taskIdentifier}</Text>
          <Text style={paragraphTight}>Environment: {environment}</Text>
          <Text style={paragraphTight}>Occurrences: {occurrenceCount}</Text>

          <Text style={paragraphLight}>{error.message}</Text>
          {error.stackTrace && (
            <CodeBlock code={error.stackTrace} theme={dracula} lineNumbers language="log" />
          )}
          <Link
            href={errorLink}
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
