export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogContext = Record<string, unknown>;

const SECRET_KEYS = ['secret', 'token', 'password', 'authorization', 'key', 'signature'];

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function sanitize(value: unknown): LogContext | unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (SECRET_KEYS.some((secretKey) => key.toLowerCase().includes(secretKey))) {
        return [key, '[redacted]'];
      }

      return [key, sanitize(entry)];
    });

    return Object.fromEntries(entries);
  }

  return value;
}

export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  if (level === 'debug' && isProduction()) {
    return;
  }

  const safeContext = sanitize(context) as LogContext;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...safeContext
  };

  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
    return;
  }

  if (level === 'warn') {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}
