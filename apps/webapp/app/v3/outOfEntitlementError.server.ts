export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
    this.name = "OutOfEntitlementError";
  }
}
