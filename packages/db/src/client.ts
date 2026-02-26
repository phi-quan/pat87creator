export interface DatabaseClient {
  provider: 'stub';
  connected: boolean;
}

export function createClient(): DatabaseClient {
  return { provider: 'stub', connected: false };
}
