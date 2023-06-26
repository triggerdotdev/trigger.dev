<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
  <source media="(prefers-color-scheme: light)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3f5ad4c1-c4c8-4277-b622-290e7f37bd00/public">
  <img alt="Trigger.dev logo" src="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
</picture>

[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/triggerdotdev.svg?style=social&label=Follow%20%40trigger.dev)](https://twitter.com/triggerdotdev)
[![GitHub Repo stars](https://img.shields.io/github/stars/triggerdotdev/trigger.dev?style=social)](https://github.com/triggerdotdev/trigger.dev)

</div>

# **The background jobs framework for Next.js**

Create long-running jobs directly in your codebase with features like API integrations, webhooks, scheduling and delays.

### Developer-first features

#### 1. Long running Jobs on serverless

Reliably run Jobs and don’t worry about function timeouts, we handle those for you.

- Auto-resume after a function timeout
- Auto-resume after a server outage
- Add delays of up to a year

#### 2. In your codebase

Create Jobs where they belong: in your codebase. Version control, localhost, test, review, and deploy like you're already used to.

#### 3. Secure by design

We only receive Triggers and the data you choose to send to us. You can even completely self-host the entire platform.

#### 4. Don't worry about deployment

Just use our SDK to write Jobs in your Next.js codebase. There's nothing extra to deploy and no CI to configure, your Jobs just connect to our cloud. Or you can always self-host.

#### 5. Full Visibility of every job run

View every Task in every Run so you can tell exactly what happened.

![image](https://www.trigger.dev/build/_assets/web-app-2QFKXFLW.png)

#### 6. Built in integrations

Easily integrate with hundreds of third-party APIs – including your own. Use API keys (which never leave your server) or let us handle OAuth for you. Install our integration packages and easily subscribe to webhooks and perform common tasks, or you can easily use your existing favorite Node.JS SDKs and get resumability and idempotency through our `runTask` function.

#### 7. Trigger.dev Connect (coming soon)

Easily add integrations for your users (section TBD)/

## Documentation

View our [docs](https://trigger-docs.mintlify.app/documentation/introduction) for (in)complete documentation.

## Self-host

We provide an official trigger.dev docker image you can use to easily self-host the platform. We're working on more extensive guides but we currently provide a [Fly.io example repository](https://github.com/triggerdotdev/fly.io) with instructions in the README for deploying and using a self-hosted instance of Trigger.dev on Fly.io.

## Development

### Prerequisites
- Node.js version >=18.x
- [pnpm package manager](https://pnpm.io/installation) version 7
- Docker 

### Setup

1. Clone the repo into a public GitHub repository or fork [https://github.com/triggerdotdev/trigger.dev/fork](https://github.com/triggerdotdev/trigger.dev/fork). If you plan to distribute the code, keep the source code public to comply with the [Apache Licence 2.0](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE).

      ```
      git clone https://github.com/triggerdotdev/trigger.dev.git
      ```
      > If you are on windows, run the following command on gitbash with admin privileges:
      > `git clone -c core.symlinks=true https://triggerdotdev/trigger.dev.git`
2. Navigate to the project folder
      ```
      cd trigger.dev
      ```
3. Install the required packages using pnpm.
      ```
      pnpm i
      ```
4. Create your `.env` file
      ```
      cp .env.example .env
      ```
      > Alternatively, duplicate the `.env.example` file and rename it to `.env`.
      
      Open the `.env` file and fill in the required values.
5. Start Docker. This starts the required services like Postgres.
      ```
      pnpm run docker:services
      ```
6. Migrate the database
      ```
      pnpm run db:migrate
      ```
8. Run the seed script
      ```
      pnpm run db:seed
      ```
5. Run the project. It should run on `port:3030`
      ```
      pnpm run dev --filter webapp
      ```
