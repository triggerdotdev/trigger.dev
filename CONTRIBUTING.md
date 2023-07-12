# Contributing to Trigger.dev

Thank you for taking the time to contribute to Trigger.dev. Your involvement is not just welcomed, but we encourage it! 🚀

Please take some time to read this guide to understand contributing best practices for Trigger.dev.

Thank you for helping us make Trigger.dev even better! 🤩

## Developing

The development branch is `main`. This is the branch that all pull
requests should be made against. The changes on the `main`
branch are tagged into a release monthly.

### Prerequisites
- [Node.js](https://nodejs.org/en) version >=16.x
- [pnpm package manager](https://pnpm.io/installation) version 7
- [Docker](https://www.docker.com/get-started/)

### Setup

1. Clone the repo into a public GitHub repository or [fork the repo](https://github.com/triggerdotdev/trigger.dev/fork). If you plan to distribute the code, keep the source code public to comply with the [Apache Licence 2.0](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE).

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
4. Create your `.env` files
      ```
      cp .env.example .env && cp packages/database/.env.example packages/database/.env
      ```
5. Open the root `.env` file and fill in the required values for these services:

      <details>
      <summary>Resend</summary>
            
      <p>We use https://resend.com for email sending (including the magic-link signup/login system). They have a generous free tier of 100 emails a day that should be sufficient. Signup for Resend.com and enter the required environment vars below.</p>
      
      ```
      RESEND_API_KEY=<api_key>
      FROM_EMAIL=
      REPLY_TO_EMAIL=
      ```
      </details>

      <details>
      <summary>Magic Link</summary>
            
      <p>Both of these secrets should be random strings, which you can easily generate (and copy into your pasteboard) with the following command:</p>
      
      ```sh
      openssl rand -hex 16 | pbcopy
      ```

      <p>Then set them here:</p>

      ```
      SESSION_SECRET=<string>
      MAGIC_LINK_SECRET=<string>
      ```
      </details>
      
7. Start Docker. This starts the required services like Postgres.
      ```
      pnpm run docker
      ```
8. Migrate the database
      ```
      pnpm run db:migrate
      ```
9. Run the seed script
      ```
      pnpm run db:seed
      ```
5. Run the project. See the section below.

## Running

You can run the project with:
      ```
      pnpm run dev --filter webapp
      ```
      
It should run on `port:3030`

## Making a pull request

**If you get errors, be sure to fix them before committing.**

- Be sure to [check the "Allow edits from maintainers" option](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork) while creating you PR.
- If your PR refers to or fixes an issue, be sure to add `refs #XXX` or `fixes #XXX` to the PR description. Replacing `XXX` with the respective issue number. See more about [Linking a pull request to an issue
  ](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue).
- Be sure to fill the PR Template accordingly.
