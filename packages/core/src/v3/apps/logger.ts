export class SimpleLogger {
  #debugEnabled = ["1", "true"].includes(process.env.DEBUG ?? "");

  constructor(private prefix?: string) {}

  log<TFirstArg>(arg0: TFirstArg, ...argN: any[]) {
    console.log(...this.#getPrefixedArgs(arg0, ...argN));

    return arg0;
  }

  debug<TFirstArg>(arg0: TFirstArg, ...argN: any[]) {
    if (!this.#debugEnabled) {
      return arg0;
    }

    console.debug(...this.#getPrefixedArgs("DEBUG", arg0, ...argN));

    return arg0;
  }

  error<TFirstArg>(arg0: TFirstArg, ...argN: any[]) {
    console.error(...this.#getPrefixedArgs(arg0, ...argN));

    return arg0;
  }

  #getPrefixedArgs(...args: any[]) {
    if (!this.prefix) {
      return args;
    }

    return [this.prefix, ...args];
  }
}
