/** Fail closed instead of ever running mutable tests on a demo/client database. */
export function requireTestDatabaseUrl(envName: string, allowedPrefix: string): string {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} required: integration suite must run against real PostgreSQL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} must be a valid PostgreSQL connection string`);
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !name.startsWith(allowedPrefix)) {
    throw new Error(`${envName} must target a disposable ${allowedPrefix}* PostgreSQL database`);
  }
  return value;
}
