import { Body, Container, Head, Html, Link, Preview, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";
import { z } from "zod";

export const PersonalAccessTokenExpiredEmailSchema = z.object({
  email: z.literal("personal-access-token-expired"),
  tokenName: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().optional(),
  tokensUrl: z.string().url(),
});

type PersonalAccessTokenExpiredEmailProps = z.infer<typeof PersonalAccessTokenExpiredEmailSchema>;

const previewDefaults: PersonalAccessTokenExpiredEmailProps = {
  email: "personal-access-token-expired",
  tokenName: "github-actions-deploy",
  expiresAt: "Wed, 18 Nov 2026 14:00:00 GMT",
  lastUsedAt: "Mon, 16 Nov 2026 08:12:40 GMT",
  tokensUrl: "https://cloud.trigger.dev/account/tokens",
};

/** Names the token, never any part of its value. */
export default function Email(props: PersonalAccessTokenExpiredEmailProps) {
  const { tokenName, expiresAt, tokensUrl } = { ...previewDefaults, ...props };
  // Optional, so it never falls back to the preview value.
  const { lastUsedAt } = props;

  return (
    <Html>
      <Head />
      <Preview>Your personal access token "{tokenName}" has expired</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Your personal access token has expired</Text>
          <Text style={paragraphLight}>Hi there,</Text>
          <Text style={paragraphLight}>
            Your personal access token "{tokenName}" expired on {expiresAt} and no longer works.{" "}
            {lastUsedAt ? `It was last used on ${lastUsedAt}.` : "It was never used."}
          </Text>
          <Text
            style={{
              ...paragraphLight,
              display: "block",
              marginBottom: "50px",
            }}
          >
            If you still need it, create a new token on your{" "}
            <Link href={tokensUrl} style={anchor}>
              personal access tokens page
            </Link>{" "}
            and replace this one wherever it's used, such as in CI.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}
