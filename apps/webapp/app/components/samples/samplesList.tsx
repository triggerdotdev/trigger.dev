import {
  StarIcon,
  EnvelopeIcon,
  ShoppingCartIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  UserIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import { customEvent } from "./custom-event";
import { githubIssues } from "./github-issues";
import { githubStars } from "./github-stars";
import { newUserSlackMessage } from "./new-user-slack-message";
import { resendEmailDripCampaign } from "./resend-email-drip-campaign";
import { shopifyCreateNewProducts } from "./shopify-create-new-product";
import { webhook } from "./webhook";
import { scheduled } from "./scheduled";

import { whatsappListenForMessageAndReply } from "./whatsapp-listen-for-message-and-reply";
import { scheduledCron } from "./scheduled-cron";

export const exampleProjects = [
  {
    icon: <StarIcon className="h-8 w-8 text-yellow-400" />,
    name: "GitHub star → Slack",
    title: "When you receive a GitHub star, post that user's details to Slack",
    description:
      "This workflow is triggered when a GitHub user adds a star to a repository. The user's details will then be posted in a specific Slack channel.",
    requiredPackages: "@trigger.dev/github @trigger.dev/slack zod",
    code: githubStars,
  },

  {
    icon: <EnvelopeIcon className="h-8 w-8 text-blue-400" />,
    name: "New user → email",
    title:
      "When a new user signs up, post a message to Slack and send them a series of emails",
    description:
      "This workflow is triggered when a new user signs up. A welcome email is sent straight away and an alert is sent to a specific Slack channel. 1 day later it checks if the user has completed the onboarding, if they have, they get a ‘tips’ email, otherwise they get a re-engagement email.",
    requiredPackages: "@trigger.dev/resend @trigger.dev/slack zod",
    code: resendEmailDripCampaign,
  },
  {
    icon: <UserIcon className="h-8 w-8 text-rose-400" />,
    name: "New user → Slack",
    title: "When a new user signs up, post a message to Slack",
    description:
      "This workflow is triggered when a new user signs up. The user's details will then be posted in a specific Slack channel.",
    requiredPackages: "@trigger.dev/slack zod",
    code: newUserSlackMessage,
  },

  {
    icon: <ShoppingCartIcon className="h-8 w-8 text-purple-400" />,
    name: "New item → Shopify",
    title: "When a custom event is triggered, create a new product in Shopify",
    description:
      "This workflow is triggered by a custom event. Once it is triggered, a new product is created in Shopify with the specified details.",
    requiredPackages: "@trigger.dev/shopify zod",
    code: shopifyCreateNewProducts,
    packagesCopy: "Shopify",
  },
  {
    icon: <DocumentTextIcon className="h-8 w-8 text-orange-400" />,
    name: "GitHub issue → Slack",
    title: "When a GitHub issue is created or modified, post it to Slack",
    description:
      "This workflow is triggered when a new issue is created or modified in GitHub. The issue will then be posted in a specific Slack channel.",
    requiredPackages: "@trigger.dev/github @trigger.dev/slack zod",
    code: githubIssues,
  },

  {
    icon: <ChatBubbleOvalLeftEllipsisIcon className="h-8 w-8 text-green-400" />,
    name: "WhatsApp → Slack",
    title: "Listen for WhatsApp messages and automatically reply",
    description:
      "This workflow is triggered when a WhatsApp message has been received. When received, a pre-determined reply is sent.",
    requiredPackages: "@trigger.dev/whatsapp zod",
    code: whatsappListenForMessageAndReply,
    packagesCopy: "WhatsApp",
  },
];

export const fromScratchProjects = [
  {
    name: "Webhook",
    requiredPackages: "@trigger.dev/sdk zod",
    code: webhook,
    docsLink: "https://docs.trigger.dev/triggers/webhooks",
    description:
      "Webhooks allow you to subscribe to events from APIs but can be difficult to work with, especially when developing locally. Trigger.dev makes using webhooks easy:",
    bulletPoint1:
      "You don’t need to register/unregister for webhooks, we do it for you.",
    bulletPoint2:
      "They work locally during development without needing to use tunnels (e.g. Ngrok).",
    bulletPoint3:
      "We receive the webhook, then keep trying to send it to you until you receive it. If your server goes down, no problem.",
  },
  {
    name: "Custom event",
    requiredPackages: "@trigger.dev/sdk zod",
    code: customEvent,
    docsLink: "https://docs.trigger.dev/triggers/custom-events",
    description:
      "Custom event triggers allow you to run workflows from your own code (or your other workflows). Send an event and any workflows that subscribe to that custom event will get triggered. You can easily send an event from anywhere, including from inside another workflow. Events don’t have to come from the same server as your workflow and can be sent as HTTP requests from any language.",
    bulletPoint1: "",
    bulletPoint2: "",
    bulletPoint3: "",
  },
  {
    name: "Scheduled (recurring)",
    requiredPackages: "@trigger.dev/sdk zod",
    code: scheduled,
    docsLink: "https://docs.trigger.dev/triggers/scheduled",
    description:
      "Run a workflow on a recurring schedule. The example below will run every 5 minutes, starting 5 minutes after this code is first run on your server (that includes running locally).",
    bulletPoint1: "",
    bulletPoint2: "",
    bulletPoint3: "",
  },
  {
    name: "Scheduled (CRON)",
    requiredPackages: "@trigger.dev/sdk zod",
    code: scheduledCron,
    docsLink: "https://docs.trigger.dev/triggers/scheduled",
    description:
      "Run a workflow on a recurring schedule. The example job below will run at 2:30pm every Monday.",
    bulletPoint1: "",
    bulletPoint2: "",
    bulletPoint3: "",
  },
];
