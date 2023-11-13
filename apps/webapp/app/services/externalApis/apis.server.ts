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
  },
  {
    identifier: "brex",
    name: "Brex",
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
  },
  {
    identifier: "discord",
    name: "Discord",
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
  },
  {
    identifier: "giphy",
    name: "Giphy",
  },
  {
    identifier: "gmail",
    name: "Gmail",
  },
  {
    identifier: "google",
    name: "Google",
  },
  {
    identifier: "googlecalendar",
    name: "Google Calendar",
  },
  {
    identifier: "googlecloudplatform",
    name: "Google Cloud Platform",
  },
  {
    identifier: "googledocs",
    name: "Google Docs",
  },
  {
    identifier: "googledrive",
    name: "Google Drive",
  },
  {
    identifier: "googlemaps",
    name: "Google Maps",
  },
  {
    identifier: "googlesheets",
    name: "Google Sheets",
  },
  {
    identifier: "hubspot",
    name: "HubSpot",
  },
  {
    identifier: "huggingface",
    name: "Hugging Face",
  },
  {
    identifier: "infisical",
    name: "Infisical",
  },
  {
    identifier: "instagram",
    name: "Instagram",
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
  },
  {
    identifier: "linkedin",
    name: "LinkedIn",
  },
  {
    identifier: "linear",
    name: "Linear",
  },
  {
    identifier: "loops",
    name: "Loops",
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
  },
  {
    identifier: "novu",
    name: "Novu",
  },
  {
    identifier: "openai",
    name: "OpenAI",
  },
  {
    identifier: "pagerduty",
    name: "PagerDuty",
  },
  {
    identifier: "plain",
    name: "Plain",
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
  },
  {
    identifier: "resend",
    name: "Resend",
  },
  {
    identifier: "salesforce",
    name: "Salesforce",
  },
  {
    identifier: "segment",
    name: "Segment",
  },
  {
    identifier: "sendgrid",
    name: "SendGrid",
  },
  {
    identifier: "shopify",
    name: "Shopify",
  },
  {
    identifier: "slack",
    name: "Slack",
  },
  {
    identifier: "snyk",
    name: "Snyk",
  },
  {
    identifier: "spotify",
    name: "Spotify",
  },
  {
    identifier: "stabilityai",
    name: "Stability AI",
  },
  {
    identifier: "stripe",
    name: "Stripe",
  },
  {
    identifier: "supabase",
    name: "Supabase",
  },
  {
    identifier: "svix",
    name: "Svix",
  },
  {
    identifier: "todoist",
    name: "Todoist",
  },
  {
    identifier: "trello",
    name: "Trello",
  },

  {
    identifier: "twilio",
    name: "Twilio",
  },
  {
    identifier: "twitter",
    name: "Twitter",
  },
  {
    identifier: "typeform",
    name: "Typeform",
  },

  {
    identifier: "whatsapp",
    name: "WhatsApp",
  },
  {
    identifier: "x",
    name: "X",
  },
  {
    identifier: "youtube",
    name: "YouTube",
  },
  {
    identifier: "zbd",
    name: "ZBD",
  },
];
