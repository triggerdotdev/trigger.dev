import {
  Body,
  Button,
  Container,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { hr } from "./components/styles";

export default function Email({ magicLink }: { magicLink: string }) {
  return (
    <Html>
      <Preview>Log in with this magic link</Preview>
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
              <Text className="text-[24px] font-bold text-[#D7D9DD] mb-8">
                Log in to Trigger.dev
              </Text>
              <Button
                href={magicLink}
                className="bg-[#A8FF53] rounded text-[#121317] text-[16px] no-underline text-center px-4 py-3 mb-8"
              >
                Log in with magic link
              </Button>
            </Section>
            <Section className="mb-6">
              <Text className="text-[14px] text-[#878C99]">
                Can&apos;t see the button? Copy and paste this link into your browser:{" "}
              </Text>
              <Link
                href={magicLink}
                target="_blank"
                className="text-[#6366F1] text-[14px] no-underline"
              >
                {magicLink}
              </Link>
            </Section>
            <Section>
              <Hr style={hr} />
              <Text className="text-[14px] mt-2 mb-0 text-[#878C99]">
                This link expires in 30 minutes and can only be used once. If you didn&apos;t try to
                log in, you can safely ignore this email.
              </Text>
            </Section>
            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
