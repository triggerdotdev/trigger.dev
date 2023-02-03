import { StarIcon, EnvelopeIcon } from "@heroicons/react/24/outline";
import { newUserSlackMessage } from "./new-user-slack-message";

export const exampleProjects = [
  {
    icon: <StarIcon className="h-8 w-8 text-yellow-400" />,
    name: "GitHub star → Slack",
    title: "When you receive a GitHub star, post that user's details to Slack",
    description:
      "Schemas are created using Zod. In this case events must send an object that has name, email, and paidPlan.",
    requiredPackages: "@trigger.dev/slack @trigger.dev/github zod",
    code: newUserSlackMessage,
    testCode: `{
      "name": "Rick Astley",
      "email": "nevergonn@giveyou.up",
      "paidPlan": true
    }
    `,
  },
  {
    icon: <EnvelopeIcon className="h-8 w-8 text-blue-400" />,
    name: "New user → email",
    title: "When a new user signs up, send them a series of emails",
    description: "Description here",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    testCode: `{
      "name": "Rick Astley",
      "email": "nevergonn@giveyou.up",
      "paidPlan": true
    }
    `,
  },
];

export const fromScratchProjects = [
  {
    name: "Webhook",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
  {
    name: "Custom event",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
  {
    name: "Scheduled (CRON)",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
    description: "",
  },
];
