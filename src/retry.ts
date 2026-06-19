export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  multiplier?: number;
  jitter?: number;
  shouldRetry?: (error: Error) => boolean;
}

const DEFAULTS: Required<Omit<RetryOptions, "shouldRetry">> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  multiplier: 2,
  jitter: 0.2,
};

function applyJitter(delay: number, jitter: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.round(delay * factor);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const { shouldRetry, ...rest } = { ...options };
  const opts = { ...DEFAULTS, ...rest };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === opts.maxRetries) break;
      if (shouldRetry && !shouldRetry(lastError)) break;
      const delay = applyJitter(
        opts.initialDelayMs * opts.multiplier ** attempt,
        opts.jitter,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
