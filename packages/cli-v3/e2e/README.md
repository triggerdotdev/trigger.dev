# Trigger.dev CLI E2E suite

E2E test suite for the Trigger.dev v3 CLI.

Note: this only works with Trigger.dev v3 projects and later. There is no E2E test suite for the [@trigger.dev/cli](https://www.npmjs.com/package/@trigger.dev/cli) package yet.

Trigger.dev is an open source platform that makes it easy to create event-driven background tasks directly in your existing project.

## Description

This suite aims to test the outputs fo the `triggerdev deploy` command.
To do so, it runs the deploy code against fixture projects that are located under `packages/cli-v3/e2e/fixtures/`.
Those fixtures reproduce minimal project structure and contents, in order to reproduce known bugs and run fast.

**Notes**

- The suite uses vitest
- Everything happens locally
- There is no login required
- There is not real project reference needed
- No docker image is created or built, instead, the bundled worker file is started with node directly inside the vitest process

## Usage

If you have not done it yet, build the CLI:

```sh
pnpm run build --filter trigger.dev
```

Then, run the v3 CLI E2E test suite:

```sh
pnpm --filter trigger.dev run test:e2e
```

| Option                 | Description                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| `MOD=<fixture-name>`   | The name of any folder directly nested under `packages/cli-v3/e2e/fixtures/` |
| `PM=<package-manager>` | The package manager to use. One of `npm`, `pnpm`, `yarn`. Defaults to `npm`  |

Example:

```sh
MOD=server-only PM=yarn pnpm --filter trigger.dev run test:e2e
```

This will run the test suite for the `server-only` fixture using `yarn` to install and resolve dependencies.

## Debugging

When debugging an issue with the `triggerdev deploy` or `triggerdev dev` command, it is recommended to reproduce it with a minimal project fixture in the e2e suite.
Check [Adding a fixture](#adding-a-fixture) for more information.

Then run:

```sh
MOD=<fixture-name> pnpm run test:e2e
```

This will test your fixture project, and generate outputs in the `packages/cli-v3/e2e/fixtures/<fixture-name>/.trigger` folder, so you can easily debug.

## Adding a fixture

1. Create a new `packages/cli-v3/e2e/fixtures/<fixture-name>` folder.

   It will hold the project to test.

2. Add a `package.json` file in your `packages/cli-v3/e2e/fixtures/<fixture-name>` folder.

   Use the following template:

   ```json package.json
   {
     "name": "<fixture-name>",
     "private": true,
     "engines": {
       "pnpm": "8.15.5",
       "yarn": "4.2.2"
     },
     "packageManager": "pnpm@8.15.5"
   }
   ```

   > The `engines` field is used to store the versions of pnpm and yarn to use when running the suite.

3. Add an empty `pnpm-workspace.yaml` in your `packages/cli-v3/e2e/fixtures/<fixture-name>` folder.

   This is necessary to prevent the Trigger.dev monorepo from handling this project.
   Please check https://github.com/pnpm/pnpm/issues/2412 for more inforation.

4. Add an empty `yarn.lock` in your fixture folder.

   This is necessary to allow to use `yarn` without having a warning on the current project being a `pnpm` project.

5. Add the following `.yarnrc.yaml` in your fixture folder.

   This will avoid having `.pnp.cjs` and `.pnp.loader.mjs` and keep versioned files to a minimum.

   ```yaml .yarnrc.yml
   nodeLinker: node-modules
   ```

6. Install the fixture dependencies and generate lockfiles.

   Like you would in any project.
   E.g. if your fixture contains a trigger task that uses the `jsdom` library:

   ```sh
   cd packages/cli-v3/e2e/fixtures/<fixture-name>
   corepack use pnpm@8.15.5
   pnpm install jsdom
   ```

   > This will update the `package.json` and generate the `pnpm-lock.yaml` file.

7. Make sure typescript is installed in the fixture project.

   ```sh
   cd packages/cli-v3/e2e/fixtures/<fixture-name>
   corepack use pnpm@8.15.5
   pnpm install typescript
   ```

   > This is necessary to typecheck the project during the test suite.

8. Add a tsconfig.json file similar to the one below:

   ```json tsconfig.json
   {
     "include": ["src/**/*.ts", "trigger.config.ts"],
     "compilerOptions": {
       "target": "es2022",
       "lib": ["ES2022", "DOM", "DOM.Iterable"],
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "moduleDetection": "force",
       "verbatimModuleSyntax": false,
       "jsx": "react",
       "strict": true,
       "alwaysStrict": true,
       "strictPropertyInitialization": false,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "noUnusedLocals": false,
       "noUnusedParameters": false,
       "noImplicitAny": true,
       "noImplicitReturns": true,
       "noImplicitThis": true,
       "noFallthroughCasesInSwitch": true,
       "resolveJsonModule": true,
       "removeComments": false,
       "esModuleInterop": true,
       "emitDecoratorMetadata": false,
       "experimentalDecorators": false,
       "downlevelIteration": true,
       "isolatedModules": true,
       "noUncheckedIndexedAccess": true,
       "pretty": true
     }
   }
   ```

9. To run the test suite against multiple package manager, we need to generate the other lockfiles.

   ```sh
   cd packages/cli-v3/e2e/fixtures/<fixture-name>
   rm -rf **/node_modules
   npm install
   rm -rf **/node_modules
   corepack use yarn@4.2.2 # will update the yarn lockfile
   ```

   > Do it in this order, otherwise `npm install` will update the existing `yarn.lock` file with legacy version 1.

10. Create a new `packages/cli-v3/e2e/fixtures/trigger` folder, and create a trigger task in it.

    Here is an example:

    ```javascript
    import { task } from "@trigger.dev/sdk/v3";

    export const helloWorldTask = task({
      id: "hello-world",
      run: async (payload) => {
        console.log("Hello, World!", payload);
      },
    });
    ```

11. Add a trigger configuration file.

    The configuration file is mandatory here, the E2E suite does not execute `trigger.dev` commands.

    ```javascript
    export const config = {
      project: "<fixture-name>",
      triggerDirectories: ["./trigger"],
    };
    ```

    > The project reference can be anything here, as the suite runs locally without connecting to the platform.

12. Commit your changes.

13. Add your fixture test configuration in `fixtures.config.js`.

    ```javascript fixtures.config.js
    export const fixturesConfig = [
      // ...
      {
        id: "<fixture-name>",
      },
      // ...
    ];
    ```

    > You might expect a specific error for a specific test, so use those configuration option at your discretion.

## Updating the SDK in the fixtures

The `@trigger.dev/sdk` package is installed in the fixtures as a real dependency (not from the monorepo).

To update it, you'll need to update the version in the `package.json` file, and then run the following commands:

> NOTE: Some fixtures don't support all the package managers, like the monorepo-react-email only supports yarn and pnpm.

```sh
cd packages/cli-v3/e2e/fixtures/<fixture-name>
rm -rf **/node_modules
corepack use pnpm@8.15.5
rm -rf **/node_modules
npm install
rm -rf **/node_modules
corepack use yarn@4.2.2
rm -rf **/node_modules
```
