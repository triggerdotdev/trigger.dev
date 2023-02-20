export function resendEmailDripCampaign(apiKey: string) {
  return `import { customEvent, Trigger } from "@trigger.dev/sdk";
import * as resend from "@trigger.dev/resend";
import * as slack from "@trigger.dev/slack";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Section } from "@react-email/section";
import { Text } from "@react-email/text";
import { z } from "zod";

new Trigger({
  //todo: ensure this id is only used for this workflow
  id: "welcome-email-campaign",
  name: "Welcome email drip campaign",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  on: customEvent({
    name: "user.created",
    schema: z.object({
      userId: z.string(),
    }),
  }),
  async run(event, context) {
    //get the user data from the database
    const user = await getUser(event.userId);

    await slack.postMessage("send-to-slack", {
      channelName: "new-users",
      text: \`New user signed up: \${user.name} (\${user.email})\`,
    });

    //Send the first email
    const welcomeResponse = await resend.sendEmail("welcome-email", {
      from: "Trigger.dev <james@email.trigger.dev>",
      replyTo: "James <james@trigger.dev>",
      to: user.email,
      subject: "Welcome to Trigger.dev",
      react: <WelcomeEmail name={user.name} />,
    });
    await context.logger.debug(
      \`Sent welcome email to \${welcomeResponse.to} with id \${welcomeResponse.id}
      \`
    );

    //wait 1 day, check if the user has created a workflow and send the appropriate email
    await context.waitFor("wait-a-while", { days: 1 });
    const updatedUser = await getUser(event.userId);

    if (updatedUser.hasOnboarded) {
      await resend.sendEmail("onboarding-complete", {
        from: "Trigger.dev <james@email.trigger.dev>",
        replyTo: "James <james@trigger.dev>",
        to: updatedUser.email,
        subject: "Pro tips for workflows",
        react: <TipsEmail name={updatedUser.name} />,
      });
    } else {
      await resend.sendEmail("onboarding-incomplete", {
        from: "Trigger.dev <james@email.trigger.dev>",
        replyTo: "James <james@trigger.dev>",
        to: updatedUser.email,
        subject: "Help with your first workflow",
        react: <InactiveEmail name={updatedUser.name} />,
      });
    }
  },
}).listen();

function WelcomeEmail({ name }: { name?: string }) {
  return (
    <Html>
      <Preview>This is the text that appears in the inbox list</Preview>
      <Section>
        <Text>Hey {name ?? "there"},</Text>
        <Text>Your message goes here.</Text>
      </Section>
    </Html>
  );
}

function TipsEmail({ name }: { name: string }) {
  return (
    <Html>
      <Preview>This is the text that appears in the inbox list</Preview>
      <Section>
        <Text>Hi {name ?? "there"},</Text>
        <Text>
          Tips content goes here
        </Text>
      </Section>
    </Html>
  );
}

function InactiveEmail({ name }: { name: string }) {
  return (
    <Html>
      <Preview>This is the text that appears in the inbox list</Preview>
      <Section>
        <Text>Hi {name ?? "there"},</Text>
        <Text>
          Re-engagement content goes here
        </Text>
      </Section>
    </Html>
  );
}

//This file is a mock database, in your real app you would access your real database from inside these functions
async function getUser(userId: string, hasOnboarded = false) {
  return {
    id: userId,
    name: "Matt Aitken",
    email: "matt@trigger.dev",
    hasOnboarded,
  };
}`;
}
