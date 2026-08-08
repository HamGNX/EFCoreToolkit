export class UserCancelledError extends Error {
  public constructor() {
    super("Operation cancelled.");
    this.name = "UserCancelledError";
  }
}

export class SafeUserError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SafeUserError";
  }
}
