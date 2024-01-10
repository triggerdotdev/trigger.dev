import os from "node:os";
import type Yargs from "yargs";
import makeCLI from "yargs";
import { version as packageVersion } from "../package.json";
import { isBuildFailure } from "./buildFailure";
import { printInitialBanner } from "./initialBanner";
import { logger } from "./logger";
import { CommonYargsArgv, CommonYargsOptions } from "./yargsTypes";

export class CommandLineArgsError extends Error {}

export function createCLIParser(argv: string[]) {
  const cli: CommonYargsArgv = makeCLI(argv)
    .strict()
    // We handle errors ourselves in a try-catch around `yargs.parse`.
    // If you want the "help info" to be displayed then throw an instance of `CommandLineArgsError`.
    // Otherwise we just log the error that was thrown without any "help info".
    .showHelpOnFail(false)
    .fail((msg, error) => {
      if (!error || error.name === "YError") {
        // If there is no error or the error is a "YError", then this came from yargs own validation
        // Wrap it in a `CommandLineArgsError` so that we can handle it appropriately further up.
        error = new CommandLineArgsError(msg);
      }
      throw error;
    })
    .scriptName("trigger.dev")
    .wrap(null)
    // Define global options here, so they get included in the `Argv` type of
    // the `trigger.dev` variable
    .version(false)
    .option("v", {
      describe: "Show version number",
      alias: "version",
      type: "boolean",
    })
    .option("config", {
      alias: "c",
      describe: "Path to your trigger.dev configuration file",
      type: "string",
      requiresArg: true,
    })
    .check((args) => {
      // Grab locally specified env params from `.env` file
      //todo load a dot dev file?
      // const loaded = loadDotEnv(".env", args.env);
      // for (const [key, value] of Object.entries(loaded?.parsed ?? {})) {
      //   if (!(key in process.env)) process.env[key] = value as string;
      // }
      return true;
    });

  cli.help().alias("h", "help");

  // Default help command that supports the subcommands
  const subHelp: Yargs.CommandModule<CommonYargsOptions, CommonYargsOptions> = {
    command: ["*"],
    handler: async (args) => {
      setImmediate(() => cli.parse([...args._.map((a) => `${a}`), "--help"]));
    },
  };
  cli.command(
    ["*"],
    false,
    () => {},
    async (args) => {
      if (args._.length > 0) {
        throw new CommandLineArgsError(`Unknown command: ${args._}.`);
      } else {
        // args.v will exist and be true in the case that no command is called, and the -v
        // option is present. This is to allow for running asynchronous printInitialBanner
        // in the version command.
        if (args.v) {
          if (process.stdout.isTTY) {
            await printInitialBanner();
          } else {
            logger.log(packageVersion);
          }
        } else {
          cli.showHelp("log");
        }
      }
    }
  );

  // You will note that we use the form for all commands where we use the builder function
  // to define options and subcommands.
  // Further we return the result of this builder even though it's not completely necessary.
  // The reason is that it's required for type inference of the args in the handle function.
  // I wish we could enforce this pattern, but this comment will have to do for now.
  // (It's also annoying that choices[] doesn't get inferred as an enum. 🤷‍♂.)

  // docs
  // cli.command(
  //   "docs [command..]",
  //   "📚 Open Trigger.dev docs in your browser",
  //   docsOptions,
  //   docsHandler
  // );

  // todo dev
  // cli.command("dev [script]", "🤖 Start a local server for development", devOptions, devHandler);

  //todo deploy
  // cli.command(
  //   ["deploy [script]", "publish [script]"],
  //   "🌍 Deploy to Trigger.dev.",
  //   deployOptions,
  //   deployHandler
  // );

  //todo login
  cli.command(
    // this needs scopes as an option?
    "login",
    "🔐 Login to Trigger.dev",
    (yargs) => {
      return yargs.option("browser", {
        default: true,
        type: "boolean",
        describe: "Automatically open the link in a browser",
      });
    },
    async (args) => {
      await printInitialBanner();
      // await login({ browser: args.browser });
      // const config = readConfig(args.config, args);
      // await metrics.sendMetricsEvent("login user", {
      //   sendMetrics: config.send_metrics,
      // });
    }
  );

  // logout
  cli.command(
    "logout",
    "🚪 Logout from Trigger.dev",
    () => {},
    async (args) => {
      await printInitialBanner();
      // await logout();
      // const config = readConfig(undefined, args);
      // await metrics.sendMetricsEvent("logout user", {
      //   sendMetrics: config.send_metrics,
      // });
    }
  );

  // whoami
  cli.command(
    "whoami",
    "🕵️  Retrieve your user info and test your auth config",
    () => {},
    async (args) => {
      await printInitialBanner();
      // await whoami();
      // const config = readConfig(undefined, args);
      // await metrics.sendMetricsEvent("view accounts", {
      //   sendMetrics: config.send_metrics,
      // });
    }
  );

  // This set to false to allow overwrite of default behaviour
  cli.version(false);

  // version
  cli.command(
    "version",
    false,
    () => {},
    async () => {
      if (process.stdout.isTTY) {
        await printInitialBanner();
      } else {
        logger.log(packageVersion);
      }
    }
  );

  cli.exitProcess(false);

  return cli;
}

export async function main(argv: string[]): Promise<void> {
  const cli = createCLIParser(argv);
  let cliHandlerThrew = false;
  try {
    await cli.parse();
  } catch (e) {
    cliHandlerThrew = true;
    logger.log(""); // Just adds a bit of space
    if (e instanceof CommandLineArgsError) {
      logger.error(e.message);
      //if there was a user-input error, we run again with the help command
      await createCLIParser([...argv, "--help"]).parse();
    } else if (e instanceof Error && e.message.includes("Raw mode is not supported on")) {
      // the current terminal doesn't support raw mode, which Ink needs to render
      // Ink doesn't throw a typed error or subclass or anything, so we just check the message content.
      // https://github.com/vadimdemedes/ink/blob/546fe16541fd05ad4e638d6842ca4cbe88b4092b/src/components/App.tsx#L138-L148

      const currentPlatform = os.platform();
      logger.error(
        `This terminal doesn't support raw mode.
        Try running your previous command in a terminal that supports raw mode, like ${
          currentPlatform === "win32"
            ? ", such as Command Prompt or Powershell."
            : currentPlatform === "darwin"
            ? ", such as Terminal.app or iTerm."
            : "."
        }`
      );
    } else if (isBuildFailure(e)) {
      logger.error(e.message);
    } else {
      logger.error(e instanceof Error ? e.message : e);
      logger.log(
        "If you think this is a bug then please create an issue at https://github.com/triggerdotdev/trigger.dev/issues"
      );
      //todo report error to Baselime
    }
    throw e;
  } finally {
    try {
      //todo do we need this?
      // In the bin script `bin/index.js`, we open an IPC channel,
      // so IPC messages from this process are propagated through the
      // bootstrapper. Normally, Node's SIGINT handler would close this for us,
      // but interactive dev mode enables raw mode on stdin which disables the
      // built-in handler. Make sure this channel is closed once it's no longer
      // needed, so we can cleanly exit. Note, we don't want to disconnect if
      // this file was imported in Jest, as that would stop communication with
      // the test runner.
      if (typeof jest === "undefined") process.disconnect?.();

      //todo stop Baselime
    } catch (e) {
      logger.error(e);
      // Only re-throw if we haven't already re-thrown an exception from a
      // command handler.
      // eslint-disable-next-line no-unsafe-finally
      if (!cliHandlerThrew) throw e;
    }
  }
}
