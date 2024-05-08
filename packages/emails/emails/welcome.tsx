import { Body, Head, Html, Link, Preview, Section, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { anchor, bullets, footerItalic, main, paragraphLight } from "./components/styles";

export default function Email({ name }: { name?: string }) {
  return (
    <Html>
      <Head />
      <Preview>Power up your workflows</Preview>
      <Body style={main}>
        <Text style={paragraphLight}>Hey {name ?? "there"},</Text>
        <Text style={paragraphLight}>I’m Matt, CEO of Trigger.dev.</Text>
        <Text style={paragraphLight}>
          Our goal is to give developers like you the ability to effortlessly create powerful
          workflows in code.
        </Text>
        <Text style={paragraphLight}>
          We recommend{" "}
          <Link style={anchor} href="https://app.trigger.dev/templates">
            getting started with one of our templates
          </Link>{" "}
          to get familiar with how Trigger.dev works, and then moving on to create your own
          workflows.
        </Text>

        <Text style={paragraphLight}>
          Feel free to reply to me if you have any questions. You can also{" "}
          <Link style={anchor} href="https://cal.com/team/triggerdotdev/call">
            schedule a call
          </Link>{" "}
          , or join our{" "}
          <Link style={anchor} href="https://discord.gg/JtBAxBr2m3">
            Discord server
          </Link>{" "}
          to connect with the community and our team.
        </Text>

        <Text style={paragraphLight}>We hope you enjoy using Trigger.dev!</Text>

        <Text style={bullets}>Best,</Text>
        <Text style={bullets}>Matt</Text>
        <Text style={paragraphLight}>CEO, Trigger.dev</Text>
        <Text style={footerItalic}>
          If you don’t want me to contact you again, please just let me know and I’ll update your
          preferences.
        </Text>
        <Footer />
      </Body>
    </Html>
  );
}
