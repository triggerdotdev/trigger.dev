export type Api = {
  identifier: string;
  name: string;
  examples?: ApiExample[];
};

export type ApiExample = {
  title: string;
  version: string;
  codeUrl: string;
  slug: string;
};

export const apisList = [
  {
    identifier: "airtable",
    name: "Airtable",
    examples: [
      {
        title: "Update Airtable when a new subscription is added to Stripe.",
        slug: "stripe-sub-update-airtable",
        version: "1.0.0",

        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/stripeNewSubscriptionUpdateAirtable.ts",
      },
      {
        title: "Add a new record to Airtable when a Typeform response is submitted.",
        version: "1.0.0",
        slug: "new-airtable-record-from-typeform",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/typeformNewSubmissionUpdateAirtable.ts",
      },
      {
        title: "Update Airtable database when there is a sale in Stripe.",
        version: "1.0.0",
        slug: "update-airtable-when-stripe-account-updated",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/syncStripeWithAirtable.ts",
      },
    ],
  },
  {
    identifier: "algolia",
    name: "Algolia",
  },
  {
    identifier: "anthropic",
    name: "Anthropic",
  },
  {
    identifier: "appsmith",
    name: "Appsmith",
  },
  {
    identifier: "appwrite",
    name: "Appwrite",
  },
  {
    identifier: "asana",
    name: "Asana",
    examples: [
      {
        title: "Get user details from Asana",
        slug: "get-user-details",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/asana.ts",
      },
    ],
  },
  {
    identifier: "atlassian",
    name: "Atlassian",
  },
  {
    identifier: "aws",
    name: "AWS",
    examples: [
      {
        title: "Trigger an AWS Lambda function with a defined payload and log the results.",
        slug: "get-user-details",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/aws.ts",
      },
    ],
  },
  {
    identifier: "brex",
    name: "Brex",
    examples: [
      {
        title: "Create a new title in a Brex account.",
        slug: "create-new-brex-title",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/brex.ts",
      },
    ],
  },
  {
    identifier: "caldotcom",
    name: "Cal.com",
    examples: [
      {
        title: "Send a Slack message when meetings are booked or cancelled.",
        slug: "cal-slack-meeting-alert",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/cal-http-endpoint.ts",
      },
      {
        title: "Find all Cal.com bookings for a user.",
        slug: "cal-find-bookings",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/cal.ts",
      },
    ],
  },
  {
    identifier: "clerk",
    name: "Clerk",
  },
  {
    identifier: "clickup",
    name: "ClickUp",
  },
  {
    identifier: "coda",
    name: "Coda",
  },
  {
    identifier: "crowddotdev",
    name: "Crowd.dev",
  },
  {
    identifier: "deepl",
    name: "DeepL",
    examples: [
      {
        title: "Translate some text with DeepL.",
        slug: "translate-text-with-deepl",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/deepl.ts",
      },
    ],
  },
  {
    identifier: "discord",
    name: "Discord",
    examples: [
      {
        title: "Create a Discord bot and send a message to a channel.",
        slug: "discord-bot-send-message",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/discord.ts",
      },
    ],
  },
  {
    identifier: "documenso",
    name: "Documenso",
  },
  {
    identifier: "dropbox",
    name: "Dropbox",
  },
  {
    identifier: "facebook",
    name: "Facebook",
  },
  {
    identifier: "fastify",
    name: "Fastify",
  },
  {
    identifier: "flickr",
    name: "Flickr",
  },
  {
    identifier: "github",
    name: "GitHub",
    examples: [
      {
        title: "Send a message to a Slack channel when a repo is starred.",
        slug: "github-star-to-slack",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/gitHubNewStarToSlack.ts",
      },
      {
        title: "Create a Linear issue when a pull request is opened on a GitHub repo.",
        slug: "linear-ticket-on-github-pr",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/linearCreateIssueOnPR.ts",
      },
      {
        title:
          "Send a reminder message to a Slack channel if a GitHub issue is left open for 24 hours.",
        slug: "github-issue-reminder",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/gitHubIssueReminder.ts",
      },

      {
        title: "Add a custom label to a GitHub issue.",
        slug: "github-custom-label",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/gitHubNewIssueOpened.ts",
      },
    ],
  },
  {
    identifier: "giphy",
    name: "Giphy",
  },
  {
    identifier: "gmail",
    name: "Gmail",
    examples: [
      {
        title: "Send an email using Gmail.",
        slug: "send-email-with-gmail",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/gmail.ts",
      },
    ],
  },
  {
    identifier: "googlecalendar",
    name: "Google Calendar",
    examples: [
      {
        title: "Create a new Google Calendar event",
        slug: "create-google-calendar-event",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/google-calendar.ts",
      },
    ],
  },
  {
    identifier: "googledocs",
    name: "Google Docs",
  },
  {
    identifier: "googledrive",
    name: "Google Drive",
    examples: [
      {
        title: "Update a filename in Google Drive.",
        slug: "update-google-drive-filename",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/google-drive.ts",
      },
    ],
  },
  {
    identifier: "googlemaps",
    name: "Google Maps",
    examples: [
      {
        title: "Make a geocode request with Google Maps.",
        slug: "google-maps-geocode",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/google-maps.ts",
      },
    ],
  },
  {
    identifier: "googlesheets",
    name: "Google Sheets",
    examples: [
      {
        title: "Insert data into a row in Google Sheets.",
        slug: "insert-data-into-google-sheets",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/google-sheets.ts",
      },
    ],
  },
  {
    identifier: "hubspot",
    name: "HubSpot",
    examples: [
      {
        title: "Create a contact in HubSpot.",
        slug: "create-contact-in-hubspot",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/hubspot.ts",
      },
    ],
  },
  {
    identifier: "huggingface",
    name: "Hugging Face",
    examples: [
      {
        title: "Text classification with Hugging Face.",
        slug: "text-classification-with-hugging-face",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/hugging-face.ts",
      },
    ],
  },
  {
    identifier: "infisical",
    name: "Infisical",
  },
  {
    identifier: "instagram",
    name: "Instagram",
    examples: [
      {
        title: "Post an image to Instagram",
        slug: "post-image-to-instagram",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/instagram.ts",
      },
    ],
  },
  {
    identifier: "instabug",
    name: "Instabug",
  },
  {
    identifier: "keep",
    name: "Keep",
  },
  {
    identifier: "lemonsqueezy",
    name: "Lemon Squeezy",
    examples: [
      {
        title: "Get store information from Lemon Squeezy.",
        slug: "get-store-information",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/lemon-squeezy.ts",
      },
    ],
  },
  {
    identifier: "linkedin",
    name: "LinkedIn",
  },
  {
    identifier: "linear",
    name: "Linear",
    examples: [
      {
        title: "Post Linear issues to Slack every weekday at 9am using Cron.",
        slug: "daily-linear-issues-slack-alert",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/linearIssuesDailySlackAlert.ts",
      },
      {
        title: "Create a Linear issue when a pull request is opened on a GitHub repo.",
        slug: "linear-ticket-on-pr",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/linearCreateIssueOnPR.ts",
      },
      {
        title: "Automatically comment and like any new Linear issues.",
        slug: "automatically-comment-and-like-linear-issues",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/linearNewIssueReply.ts",
      },
    ],
  },
  {
    identifier: "loops",
    name: "Loops",
    examples: [
      {
        title: "Create a new contact in Loops.",
        slug: "create-new-contact-in-loops",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/loops.ts",
      },
    ],
  },
  {
    identifier: "lotus",
    name: "Lotus",
  },
  {
    identifier: "mailchimp",
    name: "Mailchimp",
  },
  {
    identifier: "mailgun",
    name: "Mailgun",
    examples: [
      {
        title: "Send an email with Mailgun.",
        slug: "send-email-with-mailgun",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/mailgun.ts",
      },
    ],
  },
  {
    identifier: "microsoftazure",
    name: "Microsoft Azure",
  },
  {
    identifier: "monday",
    name: "Monday",
  },
  {
    identifier: "mux",
    name: "Mux",
  },
  {
    identifier: "notion",
    name: "Notion",
    examples: [
      {
        title: "Retrieve a Notion page by ID.",
        slug: "retrieve-notion-page",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/notion.ts",
      },
    ],
  },
  {
    identifier: "novu",
    name: "Novu",
    examples: [
      {
        title: "Create a new subscriber in Novu",
        slug: "create-new-subscriber-in-novu",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/novu.ts",
      },
    ],
  },
  {
    identifier: "openai",
    name: "OpenAI",
    examples: [
      {
        title: "Summarize GitHub commits using OpenAI and then post them to Slack.",
        slug: "openai-summarize-github-commits",
        version: "1.0.0",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/summarizeGitHubCommits.ts",
      },
      {
        title: "Generate a random joke using OpenAI.",
        slug: "openai-generate-random-joke",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/openAITellMeAJoke.ts",
      },
      {
        title: "Generate an image from a prompt using OpenAI.",
        slug: "openai-generate-image",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/openAIGenerateImage.ts",
      },
    ],
  },
  {
    identifier: "pagerduty",
    name: "PagerDuty",
  },
  {
    identifier: "plain",
    name: "Plain",
    examples: [
      {
        title: "Update or create customer information based on an identifier.",
        slug: "plain-update-customer-information",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/plainUpdateCustomer.ts",
      },
    ],
  },
  {
    identifier: "posthog",
    name: "Posthog",
  },
  {
    identifier: "raycast",
    name: "Raycast",
  },
  {
    identifier: "reddit",
    name: "Reddit",
  },
  {
    identifier: "replicate",
    name: "Replicate",
    examples: [
      {
        title: "Generate a cinematic image with Replicate.",
        slug: "generate-cinematic-image",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/replicateCinematicPrompt.ts",
      },
    ],
  },
  {
    identifier: "resend",
    name: "Resend",
    examples: [
      {
        title: "Send a drip email campaign over 30 days, triggered by an event.",
        slug: "resend-send-drip-campaign",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/resendDripCampaign.tsx",
      },
      {
        title: "Send an email built using React with Resend.",
        slug: "send-react-email",
        version: "1.0.0",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/resendSendReactEmail.tsx",
      },
      {
        title: "Send a basic email with Resend.",
        slug: "resend-send-basic-email",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/resendSendBasicEmail.ts",
      },
    ],
  },
  {
    identifier: "salesforce",
    name: "Salesforce",
    examples: [
      {
        title: "Create a new contact in Salesforce.",
        slug: "salesforce-create-contact",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/salesforce.ts",
      },
    ],
  },
  {
    identifier: "segment",
    name: "Segment",
    examples: [
      {
        title: "Get source information from Segment.",
        slug: "segment-get-source-information",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/segment.ts",
      },
    ],
  },
  {
    identifier: "sendgrid",
    name: "SendGrid",
    examples: [
      {
        title: "Send an activity summary email to users at 4pm every Friday.",
        slug: "sendgrid-send-activity-summary",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/weeklyUserActivitySummary.ts",
      },
      {
        title: "SendGrid send basic email.",
        slug: "sendgrid-send-basic-email",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/sendGridSendBasicEmail.ts",
      },
    ],
  },
  {
    identifier: "shopify",
    name: "Shopify",
    examples: [
      {
        title: "Update a product variant price in Shopify.",
        slug: "shopify-update-product-variant-price",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/shopify.ts",
      },
    ],
  },
  {
    identifier: "slack",
    name: "Slack",
    examples: [
      {
        title: "Posts Linear issues to Slack every weekday at 9am using Cron.",
        slug: "slack-daily-linear-issues",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/linearIssuesDailySlackAlert.ts",
      },
      {
        title: "Summarize GitHub commits using OpenAI and then post them to Slack.",
        slug: "slack-openai-summarize-github-commits",
        version: "1.0.0",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/summarizeGitHubCommits.ts",
      },
      {
        title: "Send an activity summary email, and post it to Slack at 4pm every Friday.",
        slug: "slack-sendgrid-send-activity-summary",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/weeklyUserActivitySummary.ts",
      },
      {
        title: "Send a message to a Slack channel when a GitHub repo is starred.",
        slug: "slack-post-github",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/gitHubNewStarToSlack.ts",
      },
      {
        title:
          "Send a reminder message to a Slack channel if a GitHub issue is left open for 24 hours.",
        slug: "slack-github-issue-reminder",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/gitHubIssueReminder.ts",
      },
    ],
  },
  {
    identifier: "snyk",
    name: "Snyk",
    examples: [
      {
        title: "Get user details from Snyk.",
        slug: "snyk-get-user-details",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/snyk.ts",
      },
    ],
  },
  {
    identifier: "spotify",
    name: "Spotify",
  },
  {
    identifier: "stabilityai",
    name: "Stability AI",
    examples: [
      {
        title: "Generate an image with Stability AI.",
        slug: "stabilityai-generate-image",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/stability.ts",
      },
    ],
  },
  {
    identifier: "stripe",
    name: "Stripe",
    examples: [
      {
        title: "Update Supabase every time a Stripe account is updated.",
        slug: "stripe-supabase-update",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/supabaseStripeUpdateDatabase.ts",
      },
      {
        title: "Update Airtable when a new subscription is added to Stripe.",
        slug: "stripe-sub-update-airtable",
        version: "1.0.0",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/stripeNewSubscriptionUpdateAirtable.ts",
      },
      {
        title: "Update Airtable database when there is a sale in Stripe.",
        version: "1.0.0",
        slug: "update-airtable-when-stripe-account-updated",
        codeUrl:
          "https://raw.githubusercontent.com/triggerdotdev/jobs-showcase/main/src/syncStripeWithAirtable.ts",
      },
    ],
  },
  {
    identifier: "supabase",
    name: "Supabase",
    examples: [
      {
        title: "Update Supabase every time a Stripe account is updated.",
        slug: "stripe-supabase-update",
        version: "1.0.0",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/supabaseStripeUpdateDatabase.ts",
      },
    ],
  },
  {
    identifier: "svix",
    name: "Svix",
    examples: [
      {
        title: "Create an application in Svix",
        slug: "svix-create-application",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/svix.ts",
      },
    ],
  },
  {
    identifier: "todoist",
    name: "Todoist",
    examples: [
      {
        title: "Add a new project in Todoist.",
        slug: "todoist-add-new-project",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/todoist.ts",
      },
    ],
  },
  {
    identifier: "trello",
    name: "Trello",
  },

  {
    identifier: "twilio",
    name: "Twilio",
    examples: [
      {
        title: "Send an SMS or WhatsApp message with Twilio",
        slug: "twilio-send-sms-or-whatsapp-message",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/twilio.ts",
      },
    ],
  },
  {
    identifier: "typeform",
    name: "Typeform",
    examples: [
      {
        title: "Add a new record to Airtable when a Typeform response is submitted.",
        version: "1.0.0",
        slug: "new-airtable-record-from-typeform",
        codeUrl:
          "https://github.com/triggerdotdev/jobs-showcase/raw/main/src/typeformNewSubmissionUpdateAirtable.ts",
      },
    ],
  },

  {
    identifier: "whatsapp",
    name: "WhatsApp",
    examples: [
      {
        title: "Send a message to a WhatsApp number",
        slug: "whatapp-send-message",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/whatsapp.ts",
      },
    ],
  },
  {
    identifier: "x",
    name: "X (Twitter)",
    examples: [
      {
        title: "Post a post to an X (Twitter) account",
        slug: "post-to-x",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/x.ts",
      },
    ],
  },
  {
    identifier: "youtube",
    name: "YouTube",
    examples: [
      {
        title: "Search for a YouTube video",
        slug: "youtube-search-video",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/youtube.ts",
      },
    ],
  },
  {
    identifier: "zbd",
    name: "ZBD",
    examples: [
      {
        title: "Send Satoshis to a ZBD account.",
        slug: "zbd-send-satoshis",
        version: "1.0.0",
        codeUrl: "https://github.com/triggerdotdev/api-reference/raw/main/src/zbd.ts",
      },
    ],
  },
];
