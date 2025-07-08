import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { container, h1, main, paragraphLight } from "./components/styles";
import { z } from "zod";

export const MfaEnabledEmailSchema = z.object({
  email: z.literal("mfa-enabled"),
  userEmail: z.string(),
});

type MfaEnabledEmailProps = z.infer<typeof MfaEnabledEmailSchema>;

const previewDefaults: MfaEnabledEmailProps = {
  email: "mfa-enabled",
  userEmail: "user@example.com",
};

export default function Email(props: MfaEnabledEmailProps) {
  const { userEmail } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>Multi-factor authentication enabled ✅</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Multi-factor authentication enabled</Text>
          <Text style={paragraphLight}>Hi there,</Text>
          <Text style={paragraphLight}>
            Multi-factor authentication was successfully enabled for your Trigger.dev account (
            {userEmail}). If you did not make this change, contact our support team immediately.
          </Text>
          <Text style={paragraphLight}>
            <strong>Staying secure:</strong>
          </Text>
          <Text style={paragraphLight}>
            • Keep your authenticator app safe and secured
            <br />
            • Never share your MFA codes with anyone
            <br />• Store your recovery codes in a secure location
          </Text>
          <Text
            style={{
              ...paragraphLight,
              display: "block",
              marginBottom: "50px",
            }}
          >
            Your account now has an additional layer of protection and you'll need to enter a code
            from your authenticator app when logging in.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
