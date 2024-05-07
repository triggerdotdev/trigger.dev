import {
  CodeBlock,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Section,
  Text,
  dracula,
} from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";

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
  const { taskIdentifier, fileName, exportName, version, environment, error, attemptLink } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>{`[${version}.${environment} ${taskIdentifier}] ${error.message}`}</Preview>
      <Section style={main}>
        <Container style={container}>
          <Text
            style={h1}
          >{`There's been an error on ${taskIdentifier} (${fileName} -> ${exportName}) [${version}.${environment}]`}</Text>

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
              marginBottom: "16px",
            }}
          >
            Investigate this error
          </Link>

          <Image path="/emails/logo-mono.png" width="156" height="28" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Section>
    </Html>
  );
}
