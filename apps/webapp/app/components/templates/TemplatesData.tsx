import GitHubStarsTemplateBg from "../../../public/images/templates/github-stars-template-bg.png";
import ResendSlackTemplateBg from "../../../public/images/templates/resend-slack-template-bg.png";
import ShopifyTemplateBg from "../../../public/images/templates/shopify-template-bg.png";

export type TemplateData = {
  title: string;
  shortTitle: string;
  description: string;
  imageURL: string;
  githubRepoURL: string;
  services: string[];
  documentation?: string;
};

export const templateData = [
  {
    title: "Slack notifications when a GitHub repo is starred",
    shortTitle: "GitHub stars to Slack",
    description:
      "When a GitHub repo is starred, post information about the user to Slack",
    imageURL: GitHubStarsTemplateBg,
    githubRepoURL: "repo-url",
    services: ["slack", "github"],
    documentation: `
    ### 🚀 Installation

Download the Mintlify CLI using the following command

\`\`\`
npm i -g mintlify
\`\`\`

### 👩‍💻 Development

Run the following command at the root of your Mintlify application to preview changes locally.

\`\`\`
mintlify dev
\`\`\`

Note - \`mintlify dev\` requires \`yarn\` and it's recommended you install it as a global installation. If you don't have yarn installed already run \`npm install --global yarn\` in your terminal.

### Custom Ports

Mintlify uses port 3000 by default. You can use the \`--port\` flag to customize the port Mintlify runs on. For example, use this command to run in port 3333:

\`\`\`
mintlify dev --port 3333
\`\`\`

You will see an error like this if you try to run Mintlify in a port that's already taken:

\`\`\`
Error: listen EADDRINUSE: address already in use :::3000
\`\`\`

    `
  },
  {
    title: "New user welcome email drip campaign",
    shortTitle: "GitHub stars to Slack",
    description: "Create a welcome email drip campaign using Slack and Resend",
    imageURL: ResendSlackTemplateBg,
    githubRepoURL: "repo-url",
    services: ["slack", "github"],
  },
  {
    title: "Add a new product to Shopify",
    shortTitle: "GitHub stars to Slack",
    description: "Add a new product to Shopify",
    imageURL: ShopifyTemplateBg,
    githubRepoURL: "repo-url",
    services: ["slack", "github"],
  },
];
