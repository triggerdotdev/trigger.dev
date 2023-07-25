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
8. Run the seed script
   ```
   pnpm run db:seed
   ```
9. Run the app. See the section below.

## Running

1. You can run the app with:

   ```
   pnpm run dev --filter webapp
   ```

   It should run on port `3030`: [http://localhost:3030](http://localhost:3030/)

2. Once the app is running click the magic link button and enter your email.
3. Check your terminal, the magic link email should have printed out.
4. Paste the magic link shown in your terminal into your browser to login.

## Making a pull request

**If you get errors, be sure to fix them before committing.**

- Be sure to [check the "Allow edits from maintainers" option](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork) while creating you PR.
- If your PR refers to or fixes an issue, be sure to add `refs #XXX` or `fixes #XXX` to the PR description. Replacing `XXX` with the respective issue number. See more about [Linking a pull request to an issue
  ](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue).
- Be sure to fill the PR Template accordingly.

## Adding changesets

We use changesets to track changes and structure the descriptions of various changes in this project in a format that is readable/comprehensible by everyone.

Since Trigger.dev is a monorepo that contains various packages, it is important that we integrate this workflow.

Before you create a Pull Request be sure to use the command below to add a changeset describing what you have done.

```shell
pnpm changeset:add
```

When you initiate the command above, you'll be presented with some prompts in your terminal. Try to answer them.

Below are some screenshots that represent what you should expect. Most times, the changes you'll make are likely to be categorized under minor releases.

| List of packages                                                                                                     | Type of release                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ![list of packages in trigger dot dev](https://res.cloudinary.com/meje/image/upload/v1690290222/packages_rm0khe.png) | ![type of release](https://res.cloudinary.com/meje/image/upload/v1690290221/type_of_release_jwhcap.png) |

But, if you think your change could be otherwise, you can reach out to [@ericallam](https://github.com/ericallam) for more information on which option to go with.

PS: you should only create a changeset if your fix or contribution is related to any of the Trigger.dev packages.
