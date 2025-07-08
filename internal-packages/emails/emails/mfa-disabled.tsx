import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { container, h1, main, paragraphLight } from "./components/styles";
import { z } from "zod";

export const MfaDisabledEmailSchema = z.object({
  email: z.literal("mfa-disabled"),
  userEmail: z.string(),
});

type MfaDisabledEmailProps = z.infer<typeof MfaDisabledEmailSchema>;

const previewDefaults: MfaDisabledEmailProps = {
  email: "mfa-disabled",
  userEmail: "user@example.com",
};

export default function Email(props: MfaDisabledEmailProps) {
  const { userEmail } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>Multi-factor authentication disabled</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Multi-factor authentication disabled</Text>
          <Text style={paragraphLight}>Hi there,</Text>
          <Text style={paragraphLight}>
            You have successfully disabled multi-factor authentication (MFA) for your Trigger.dev
            account ({userEmail}). Your account no longer has the additional security layer provided
            by MFA.
          </Text>
          <Text style={paragraphLight}>
            You can re-enable MFA at any time from your account security page. If you didn't disable
            MFA, please contact our support team immediately.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
