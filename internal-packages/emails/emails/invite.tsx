import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import { z } from "zod";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { anchor, container, h1, main, paragraphLight } from "./components/styles";

export const InviteEmailSchema = z.object({
  email: z.literal("invite"),
  orgName: z.string(),
  inviterName: z.string().optional(),
  inviterEmail: z.string(),
  inviteLink: z.string().url(),
});

export default function Email({
  orgName,
  inviterName,
  inviterEmail,
  inviteLink,
}: z.infer<typeof InviteEmailSchema>) {
  return (
    <Html>
      <Preview>{`You've been invited to ${orgName}`}</Preview>
      <Tailwind>
        <Body className="bg-[#121317] my-auto mx-auto font-sans">
          <Container className="my-[40px] mx-auto p-[20px] max-w-[600px]">
            <Section className="mt-[32px]">
              <Image
                path="/emails/logo.png"
                width="180px"
                height="32px"
                alt="Trigger.dev"
                className="mt-0 mb-12"
              />
              <Text className="text-[24px] font-bold text-[#D7D9DD] mb-8">{`You've been invited to ${orgName}`}</Text>
              <Text style={paragraphLight}>
                {inviterName ?? inviterEmail} has invited you to join their organization on
                Trigger.dev.
              </Text>
              <Button
                href={inviteLink}
                className="bg-[#A8FF53] rounded text-[#121317] text-[16px] no-underline text-center px-4 py-3 mb-8"
              >
                View the invitation
              </Button>
            </Section>
            <Section className="mb-6">
              <Text className="text-[14px] text-[#878C99]">
                Can&apos;t see the button? Copy and paste this link into your browser:
              </Text>
              <Link
                href={inviteLink}
                target="_blank"
                className="text-[#6366F1] text-[14px] no-underline"
              >
                {inviteLink}
              </Link>
            </Section>
            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
