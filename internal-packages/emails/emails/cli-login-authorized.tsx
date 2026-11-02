import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";
import { z } from "zod";

export const CliLoginAuthorizedEmailSchema = z.object({
  email: z.literal("cli-login-authorized"),
  userEmail: z.string(),
  clientDescription: z.string(),
  obfuscatedToken: z.string(),
  requesterIp: z.string().optional(),
  requesterLocation: z.string().optional(),
  authorizedAt: z.string(),
  tokensUrl: z.string().url(),
});

type CliLoginAuthorizedEmailProps = z.infer<typeof CliLoginAuthorizedEmailSchema>;

const previewDefaults: CliLoginAuthorizedEmailProps = {
  email: "cli-login-authorized",
  userEmail: "user@example.com",
  clientDescription: "the Trigger.dev CLI",
  obfuscatedToken: "tr_pat_bhbd••••••••••••••••••fd4a",
  authorizedAt: "Oct 26, 2026, 3:04 PM UTC",
  tokensUrl: "https://cloud.trigger.dev/account/tokens",
};

/** The IP and its location are optional, so they never fall back to preview values. */
export default function Email(props: CliLoginAuthorizedEmailProps) {
  const { userEmail, clientDescription, obfuscatedToken, authorizedAt, tokensUrl } = {
    ...previewDefaults,
    ...props,
  };
  const { requesterIp, requesterLocation } = props;
  const startedFrom = requesterIp
    ? `. The login was started from IP address ${requesterIp}${
        requesterLocation ? ` (${requesterLocation})` : ""
      }`
    : "";

  return (
    <Html>
      <Head />
      <Preview>A new login was authorized on your Trigger.dev account</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>New login authorized</Text>
          <Text style={paragraphLight}>Hi there,</Text>
          <Text style={paragraphLight}>
            You authorized {clientDescription} to access your Trigger.dev account ({userEmail}) on{" "}
            {authorizedAt}
            {startedFrom}. It created the personal access token {obfuscatedToken}.
          </Text>
          <Text
            style={{
              ...paragraphLight,
              display: "block",
              marginBottom: "50px",
            }}
          >
            If this wasn't you, revoke that token on your{" "}
            <Link href={tokensUrl} style={anchor}>
              personal access tokens page
            </Link>{" "}
            and contact our support team.
          </Text>
          {requesterIp && requesterLocation && (
            <Text style={{ ...paragraphLight, fontSize: "12px", marginBottom: "30px" }}>
              <Link href="https://ipinfo.io" style={anchor}>
                IP address data powered by IPinfo
              </Link>
            </Text>
          )}
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
