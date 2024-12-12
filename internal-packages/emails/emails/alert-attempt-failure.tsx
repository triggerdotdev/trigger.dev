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

export const AlertAttemptEmailSchema = z.object({
  email: z.literal("alert-attempt"),
  taskIdentifier: z.string(),
  fileName: z.string(),
  exportName: z.string(),
  version: z.string(),
  environment: z.string(),
  error: z.object({
    message: z.string(),
    name: z.string().optional(),
    stackTrace: z.string().optional(),
  }),
  attemptLink: z.string().url(),
  organization: z.string(),
});

const previewDefaults = {
  taskIdentifier: "my-task",
  fileName: "other.ts",
  exportName: "myTask",
  version: "20240101.1",
  environment: "prod",
  error: {
    message: "Error message",
    name: "Error name",
    stackTrace: "Error stack trace",
  },
  attemptLink: "https://trigger.dev",
};

export default function Email(props: z.infer<typeof AlertAttemptEmailSchema>) {
  const {
    taskIdentifier,
    fileName,
    exportName,
    version,
    environment,
    error,
    attemptLink,
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
          <Text style={h1}>There's been an error on `{taskIdentifier}`</Text>
          <Text style={paragraphTight}>Task ID: {taskIdentifier}</Text>
          <Text style={paragraphTight}>Filename: {fileName}</Text>
          <Text style={paragraphTight}>Function: {exportName}()</Text>
          <Text style={paragraphTight}>Version: {version}</Text>
          <Text style={paragraphTight}>Environment: {environment}</Text>
          <Text style={paragraphTight}>Organization: {organization}</Text>

          <Text style={paragraphLight}>{error.message}</Text>
          {error.stackTrace && (
            <CodeBlock code={error.stackTrace} theme={dracula} lineNumbers language="log" />
          )}
          <Link
            href={attemptLink}
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
