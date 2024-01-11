import chalk from "chalk";
import CLITable from "cli-table3";

export type Logger = typeof logger;

export type TableRow<Keys extends string> = Record<Keys, string>;

export const logger = {
  log(...args: unknown[]) {
    console.log(...args);
  },
  error(...args: unknown[]) {
    console.log(chalk.red(...args));
  },
  warn(...args: unknown[]) {
    console.log(chalk.yellow(...args));
  },
  info(...args: unknown[]) {
    console.log(chalk.cyan(...args));
  },
  success(...args: unknown[]) {
    console.log(chalk.green(...args));
  },
  table<Keys extends string>(data: TableRow<Keys>[]) {
    if (data.length === 0) return console.log("No data");
    const keys: Keys[] = data.length === 0 ? [] : (Object.keys(data[0] as {}) as Keys[]);
    const t = new CLITable({
      head: keys,
      style: {
        head: chalk.level ? ["blue"] : [],
        border: chalk.level ? ["gray"] : [],
      },
    });
    t.push(...data.map((row) => keys.map((k) => row[k])));
    return this.log(t.toString());
  },
};
