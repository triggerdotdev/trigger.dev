import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";

export const ConfirmEmailChangeEmailSchema = z.object({
  email: z.literal("confirm-email-change"),
  confirmLink: z.string().url(),
});

type ConfirmEmailChangeEmailProps = z.infer<typeof ConfirmEmailChangeEmailSchema>;

const previewDefaults: ConfirmEmailChangeEmailProps = {
  email: "confirm-email-change",
  confirmLink: "https://cloud.trigger.dev/account/email/confirm?token=example",
};

export default function Email(props: ConfirmEmailChangeEmailProps) {
  const { confirmLink } = { ...previewDefaults, ...props };

  return (
    <Html>
      <Head />
      <Preview>Confirm your new email address</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Confirm your new email address</Text>
          <Text style={paragraphLight}>
            Someone asked to use this address for their Trigger.dev account. Open the link below to
            finish the change.
          </Text>
          <Link href={confirmLink} target="_blank" style={{ ...anchor, display: "block" }}>
            Confirm this email address
          </Link>
          <Text style={{ ...paragraphLight, display: "block", marginBottom: "50px" }}>
            The link expires in one hour. If you didn&apos;t request this, you can safely ignore
            this email.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
