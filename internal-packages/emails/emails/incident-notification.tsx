import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import { Button } from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { container, h1, main, paragraphLight, sans } from "./components/styles";

export const IncidentNotificationEmailSchema = z.object({
  email: z.literal("incident-notification"),
  name: z.string(),
  statusLabel: z.string(),
  body: z.string(),
  url: z.string().url(),
});

type IncidentNotificationEmailProps = z.infer<typeof IncidentNotificationEmailSchema>;

const previewDefaults: IncidentNotificationEmailProps = {
  email: "incident-notification",
  name: "Test notification — all systems calm",
  statusLabel: "Resolved",
  body: "This is a test of the incident notification email. Nothing is wrong — everything is operational.",
  url: "https://status.trigger.dev",
};

export default function Email(props: IncidentNotificationEmailProps) {
  const { name, statusLabel, body, url } = { ...previewDefaults, ...props };

  return (
    <Html>
      <Head />
      <Preview>{`Trigger.dev ${statusLabel}: ${name}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>{name}</Text>
          <Text style={paragraphLight}>
            <strong>Status:</strong> {statusLabel}
          </Text>

          {body ? <Text style={paragraphLight}>{body}</Text> : null}

          <Button
            style={{
              ...sans,
              boxSizing: "border-box",
              padding: "12px 24px",
              borderRadius: "8px",
              backgroundColor: "#615FFF",
              textAlign: "center",
              fontWeight: "600",
              color: "#ffffff",
              marginTop: "24px",
              marginBottom: "32px",
            }}
            href={url}
          >
            View status page
          </Button>

          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
