export class OriginError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: any
  ) {
    super(message);
    this.name = 'OriginError';
  }
}

export class OriginAuthError extends OriginError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
    this.name = 'OriginAuthError';
  }
}

export class OriginNotFoundError extends OriginError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
    this.name = 'OriginNotFoundError';
  }
}
