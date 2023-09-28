// Redacts the given object based on the given paths
// Example:
// const redactor = new Redactor(["data.object.balance_transaction"]);
// redactor.redact({
//   data: {
//     object: {
//       balance_transaction: "txn_1NYWgTI0XSgju2urW3aXpinM",
//     },
//   },
// });
// Returns:
// {
//   data: {
//     object: {
//      balance_transaction: "[REDACTED]",
//     },
//   },
// }
// Does not currenly support arrays
export class Redactor {
  constructor(private paths: string[]) {}

  public redact(subject: unknown): unknown {
    if (!Array.isArray(this.paths)) {
      return subject;
    }

    if (this.paths.length === 0) {
      return subject;
    }

    const clonedSubject = JSON.parse(JSON.stringify(subject));

    return this.redactPathsRecursive(clonedSubject, this.paths);
  }

  private redactPathsRecursive(subject: any, paths: string[]): any {
    for (let path of paths) {
      let parts = path.split(".");

      let curSubject = subject;

      // Make sure curSubject is an object
      if (typeof curSubject !== "object") {
        break;
      }

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (Object.prototype.hasOwnProperty.call(curSubject, part) === false) {
          // Path is not found in object
          break;
        }

        if (i === parts.length - 1) {
          // We're at the end of our path and have a string, redact it
          curSubject[part] = "[REDACTED]";
        } else if (part in curSubject && typeof curSubject[part] === "object") {
          // More paths to follow, continue down the path
          curSubject = curSubject[part];
        } else {
          // Path is not found in object or doesn't point to a string
          break;
        }
      }
    }

    return subject;
  }
}
