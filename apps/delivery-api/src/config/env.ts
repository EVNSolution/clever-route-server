export type AppEnv = {
  nodeEnv: string;
  port: number;
  logLevel: string;
};

const DEFAULT_PORT = 3000;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return {
    nodeEnv: input.NODE_ENV ?? 'development',
    port: parsePort(input.PORT),
    logLevel: input.LOG_LEVEL ?? 'info'
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535. Received: ${value}`);
  }

  return parsed;
}
