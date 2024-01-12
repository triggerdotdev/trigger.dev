import chalk from "chalk";

export const green = "#4FFF54";
export const purple = "#735BF3";

export function chalkGreen(text: string) {
  return chalk.hex(green)(text);
}

export function chalkPurple(text: string) {
  return chalk.hex(purple)(text);
}

export function chalkGrey(text: string) {
  return chalk.hex("#666")(text);
}

export function chalkError(text: string) {
  return chalk.red(text);
}

export function chalkSuccess(text: string) {
  return chalk.green(text);
}

export function logo() {
  return `${chalk.hex(green).bold("Trigger")}${chalk.hex(purple).bold(".dev")}`;
}
