import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { container, h1, main, paragraphLight } from "./components/styles";

export const EmailChangedEmailSchema = z.object({
  email: z.literal("email-changed"),
  newEmail: z.string(),
});

type EmailChangedEmailProps = z.infer<typeof EmailChangedEmailSchema>;

const previewDefaults: EmailChangedEmailProps = {
  email: "email-changed",
  newEmail: "new@example.com",
};

/** Sent to the previous address after a change completes. */
export default function Email(props: EmailChangedEmailProps) {
  const { newEmail } = { ...previewDefaults, ...props };

  return (
    <Html>
      <Head />
      <Preview>Your Trigger.dev email address was changed</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Your email address was changed</Text>
          <Text style={paragraphLight}>
            The email address on your Trigger.dev account was changed from this address to{" "}
            {newEmail}. Sign-in links and notifications will now go there.
          </Text>
          <Text style={{ ...paragraphLight, display: "block", marginBottom: "50px" }}>
            If you did not make this change, contact our support team immediately.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
