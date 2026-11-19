import { afterEach, describe, expect, it } from 'vitest';

import { requireTestDatabaseUrl } from '../integration/test-urls.js';

const original = process.env['TEST_DATABASE_URL'];
afterEach(() => {
  if (original === undefined) delete process.env['TEST_DATABASE_URL'];
  else process.env['TEST_DATABASE_URL'] = original;
});

describe('destructive integration test URL guard', () => {
  it('accepts only an exact disposable name over loopback', () => {
    const value = 'postgres://tester:synthetic@127.0.0.1:5437/gateway_test';
    process.env['TEST_DATABASE_URL'] = value;
    expect(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toBe(value);
  });

  it('rejects missing test URL', () => {
    delete process.env['TEST_DATABASE_URL'];
    expect(() => requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toThrow(/required/);
  });

  it('rejects remote databases even if their name looks disposable', () => {
    process.env['TEST_DATABASE_URL'] = 'postgres://tester:synthetic@db.example.com:5432/gateway_test';
    expect(() => requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toThrow(/local disposable/);
  });

  it('rejects demo or lookalike database names', () => {
    for (const name of ['gateway_db', 'gateway_test_production', 'gateway_testing']) {
      process.env['TEST_DATABASE_URL'] = `postgres://tester:synthetic@localhost:5432/${name}`;
      expect(() => requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toThrow(/local disposable/);
    }
  });

  it('rejects URL query options that could override connection settings', () => {
    process.env['TEST_DATABASE_URL'] =
      'postgres://tester:synthetic@127.0.0.1:5437/gateway_test?host=remote.example.com';
    expect(() => requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toThrow(/no URL overrides/);
    process.env['TEST_DATABASE_URL'] = 'postgres://tester:synthetic@127.0.0.1:5437/gateway_test#extra';
    expect(() => requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test')).toThrow(/no URL overrides/);
  });
});
