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
5. Open the root `.env` file and fill in the required values Magic Link:

   Both of these secrets should be random strings, which you can easily generate (and copy into your pasteboard) with the following command:

   ```sh
   openssl rand -hex 16 | pbcopy
   ```

     <p>Then set them here:</p>

   ```
   SESSION_SECRET=<string>
   MAGIC_LINK_SECRET=<string>
   ```

6. Start Docker. This starts the required services like Postgres. If this is your first time using Docker, consider going through this [guide](DOCKER_INSTALLATION.md)
   ```
   pnpm run docker
   ```
7. Migrate the database
   ```
   pnpm run db:migrate
   ```
8. Build the app
   ```
   pnpm run build --filter webapp
   ```
9. Run the seed script
   ```
   pnpm run db:seed
   ```
10. Run the app. See the section below.

## Running
1. You can run the app with:

   ```
   pnpm run dev --filter webapp
   ```

   It should run on port `3030`: [http://localhost:3030](http://localhost:3030/)

2. Once the app is running click the magic link button and enter your email.
3. Check your terminal, the magic link email should have printed out as following:
``
webapp:dev: Log in to Trigger.dev
webapp:dev: 
webapp:dev: Click here to log in with this magic link
webapp:dev: [http://localhost:3030/magic?token=U2FsdGVkX18OvB0JxgaswTLCSbaRz%2FY82TN0EZWhSzFyZYwgG%2BIzKVTkeiaOtWfotPw7F8RwFzCHh53aBpMEu%2B%2B%2FItb%2FcJYh89MSjc3Pz92bevoEjqxSQ%2Ff%2BZbks09JOpqlBbYC3FzGWC8vuSVFBlxqLXxteSDLthZSUaC%2BS2LaA%2BJgp%2BLO7hgjAaC2lXbCHrM7MTgTdXOFt7i0Dvvuwz6%2BWY25RnfomZOPqDsyH0xz8Q2rzPTz0Xu53WSXrZ1hd]
webapp:dev: 
webapp:dev: If you didn't try to log in, you can safely ignore this email.
``
4. Paste the magic link shown in your terminal into your browser to login.

## Testing CLI changes
To test CLI changes, follow the steps below:

1. Build the CLI and watch for changes
   
   ```
   cd packages/cli
   pnpm run dev
   ```

2. Open a new Terminal window and run the webapp locally and then create a new project in the dashboard. Copy out the dev API key.

3. Create a new temporary Next.js app in examples directory

   ```
   pnpm create next-app@latest
   ```

   Follow the prompts to create a TypeScript project using the App Directory.

4. Then once that's finished, add the `@trigger.dev/cli` to the `devDependencies` of the newly created Next.js app's `package.json` file, like so:

   ```
   {
      "devDependencies": { "@trigger.dev/cli": "workspace:*" }
   }
   ```

5. Open a new terminal window, navigate into the example, and initialize the CLI:
   
   ```
   cd examples/your-newly-created-nextjs-project
   pnpm i
   pnpm exec trigger-cli init
   ```

6. When prompted, select `self-hosted` and enter `localhost:3030` for your local version of the webapp. When asked for an API key, use the key you copied earlier.

7. Run the CLI
   ```
   pnpm exec trigger-cli dev
   ```

8. After running the CLI, start your newly created Next.js project. You should now be able to see the changes.

9. Please remember to delete the temporary project you created after you've tested the changes, and before you raise a PR.
## Add sample jobs

The [examples/jobs-starter](./examples/jobs-starter/) project defines simple jobs you can get started with.

1. `cd` into `examples/jobs-starter`
2. Create a `.env.local` file with the following content, 
   replacing `[TRIGGER_DEV_API_KEY]` with an actual key:

   ```
   TRIGGER_API_KEY=[TRIGGER_DEV_API_KEY]
   TRIGGER_API_URL=http://localhost:3030
   ```

   `TRIGGER_API_URL` is used to configure the URL for your Trigger.dev instance,
   where the jobs will be registered.

3. Run the `jobs-starter` app:

   ```
   pnpm dev
   ```

4. Navigate to your trigger.dev instance ([http://localhost:3030](http://localhost:3030/)), to see the jobs.
   You can use the test feature to trigger them.

## Making a pull request

**If you get errors, be sure to fix them before committing.**

- Be sure to [check the "Allow edits from maintainers" option](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork) while creating you PR.
- If your PR refers to or fixes an issue, be sure to add `refs #XXX` or `fixes #XXX` to the PR description. Replacing `XXX` with the respective issue number. See more about [Linking a pull request to an issue
  ](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue).
- Be sure to fill the PR Template accordingly.

## Troubleshooting

### EADDRINUSE: address already in use :::3030

When receiving the following error message:
``
webapp:dev: Error: listen EADDRINUSE: address already in use :::3030
``

The process running on port `3030` should be destroyed.

1. Get the `PID` of the process running on PORT `3030`
   ```
   lsof -i :3030
   ```
2. Kill the process
   ```
   sudo kill -9 <PID>
   ```
