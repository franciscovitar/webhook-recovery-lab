/** Fail closed: integration tests may mutate only the two local disposable databases. */
export function requireTestDatabaseUrl(envName: string, databaseName: string): string {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} required: integration suite must run against real PostgreSQL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} must be a valid PostgreSQL connection string`);
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !loopback ||
    name !== databaseName ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `${envName} must target the local disposable ${databaseName} database with no URL overrides`,
    );
  }
  return value;
}
