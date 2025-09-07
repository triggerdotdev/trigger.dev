import {
  Body,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Tailwind,
  Text,
} from "@react-email/components";
import { Footer } from "./components/Footer";

export default function Email({ name }: { name?: string }) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Trigger.dev</Preview>
      <Tailwind>
        <Body className="bg-[#121317] my-auto mx-auto font-sans">
          <Container className="mb-[40px] mx-auto p-[20px] max-w-[600px] text-[#D7D9DD]">
            <Text className="text-[16px]">Hey {name ?? "there"},</Text>
            <Text className="text-[16px]">I’m Matt, CEO of Trigger.dev.</Text>
            <Text className="text-[16px]">
              Our goal is to give developers like you the ability to effortlessly create powerful AI
              agents and workflows in code.
            </Text>
            <Text className="text-[16px]">
              I recommend our{" "}
              <Link
                className="text-[#6366F1] text-[16px] no-underline"
                href="https://trigger.dev/docs/quick-start"
              >
                quick start guide
              </Link>{" "}
              to get started, or{" "}
              <Link
                className="text-[#6366F1] text-[16px] no-underline"
                href="https://trigger.dev/docs/guides/introduction"
              >
                one of our examples
              </Link>{" "}
              to get familiar with how Trigger.dev works, and then move on to create your own
              workflow.
            </Text>

            <Text className="text-[16px]">
              Feel free to reply to this email if you have any questions or join our{" "}
              <Link
                className="text-[#6366F1] text-[16px] no-underline"
                href="https://discord.gg/JtBAxBr2m3"
              >
                Discord
              </Link>{" "}
              to connect with the community and our team.
            </Text>

            <Text className="text-[16px]">We hope you enjoy using Trigger.dev!</Text>

            <Text className="text-[16px]">Best,</Text>
            <Text className="text-[16px]">Matt</Text>
            <Text className="text-[16px]">CEO, Trigger.dev</Text>
            <Text className="text-[16px]">
              If you don’t want me to contact you again, please just let me know and I’ll update
              your preferences.
            </Text>
            <Footer />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
