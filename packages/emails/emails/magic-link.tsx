import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraph } from "./components/styles";

export default function Email({ magicLink }: { magicLink: string }) {
  return (
    <Html>
      <Head />
      <Preview>Log in with this magic link 🪄</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Log in to Trigger.dev</Text>
          <Link
            href={magicLink}
            target="_blank"
            style={{
              ...anchor,
              display: "block",
              marginBottom: "32px",
            }}
          >
            Click here to log in with this magic link
          </Link>
          <Text style={paragraph}>
            If you didn&apos;t try to log in, you can safely ignore this email.
          </Text>
          <Image path="/emails/logo-mono.png" width="156" height="28" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
