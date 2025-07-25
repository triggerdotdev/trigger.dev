import { log } from "@clack/prompts";
import chalk from "chalk";
import { terminalLink, TerminalLinkOptions } from "./terminalLink.js";
import { hasTTY } from "std-env";

export const isInteractive = hasTTY;
export const isLinksSupported = terminalLink.isSupported;

export const green = "#4FFF54";
export const purple = "#735BF3";

export function chalkGreen(text: string) {
  return chalk.hex(green)(text);
}

export function chalkPurple(text: string) {
  return chalk.hex(purple)(text);
}

export function chalkGrey(text: string) {
  return chalk.hex("#878C99")(text);
}

export function chalkError(text: string) {
  return chalk.hex("#E11D48")(text);
}

export function chalkWarning(text: string) {
  return chalk.yellow(text);
}

export function chalkSuccess(text: string) {
  return chalk.hex("#28BF5C")(text);
}

export function chalkLink(text: string) {
  return chalk.underline.hex("#D7D9DD")(text);
}

export function chalkWorker(text: string) {
  return chalk.yellowBright(text);
}

export function chalkTask(text: string) {
  return chalk.hex("#60A5FA")(text);
}

export function chalkRun(text: string) {
  return chalk.hex("#A78BFA")(text);
}

export function logo() {
  return `${chalk.hex(green).bold("Trigger")}${chalk.hex(purple).bold(".dev")}`;
}

// Mar 27 09:17:25.653
export function prettyPrintDate(date: Date = new Date()) {
  let formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  // Append milliseconds
  formattedDate += "." + ("00" + date.getMilliseconds()).slice(-3);

  return formattedDate;
}

export function prettyError(header: string, body?: string, footer?: string) {
  const prefix = "Error: ";
  const indent = Array(prefix.length).fill(" ").join("");
  const spacing = "\n\n";

  const prettyPrefix = chalkError(prefix);

  const withIndents = (text?: string) =>
    text
      ?.split("\n")
      .map((line) => `${indent}${line}`)
      .join("\n");

  const prettyBody = withIndents(body?.trim());
  const prettyFooter = withIndents(footer);

  log.error(
    `${prettyPrefix}${header}${prettyBody ? `${spacing}${prettyBody}` : ""}${
      prettyFooter ? `${spacing}${prettyFooter}` : ""
    }`
  );
}

export function prettyWarning(header: string, body?: string, footer?: string) {
  const prefix = "Warning: ";
  const indent = Array(prefix.length).fill(" ").join("");
  const spacing = "\n\n";

  const prettyPrefix = chalkWarning(prefix);

  const withIndents = (text?: string) =>
    text
      ?.split("\n")
      .map((line) => `${indent}${line}`)
      .join("\n");

  const prettyBody = withIndents(body);
  const prettyFooter = withIndents(footer);

  log.warn(
    `${prettyPrefix}${header}${prettyBody ? `${spacing}${prettyBody}` : ""}${
      prettyFooter ? `${spacing}${prettyFooter}` : ""
    }`
  );
}

export function aiHelpLink({
  dashboardUrl,
  project,
  query,
}: {
  dashboardUrl: string;
  project: string;
  query: string;
}) {
  const searchParams = new URLSearchParams();

  //the max length for a URL is 1950 characters
  const clippedQuery = query.slice(0, 1950);

  searchParams.set("q", clippedQuery);
  const url = new URL(`/projects/${project}/ai-help`, dashboardUrl);
  url.search = searchParams.toString();

  log.message(chalkLink(cliLink("💡 Get a fix for this error using AI", url.toString())));
}

export function cliLink(text: string, url: string, options?: TerminalLinkOptions) {
  return terminalLink(text, url, {
    fallback: (text, url) => `${text} ${url}`,
    ...options,
  });
}
