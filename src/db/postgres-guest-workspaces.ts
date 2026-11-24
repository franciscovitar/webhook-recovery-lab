import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { guestSessionLimits, guestTokenDigest, newGuestToken } from '../core/guest-session.js';

export interface GuestWorkspace {
  id: string;
  created_at: Date;
  expires_at: Date;
}

export type GuestAdmission =
  { status: 'created'; workspace: GuestWorkspace; token: string } | { status: 'capacity' };

export class PostgresGuestWorkspaceStore {
  constructor(private readonly pool: Pool) {}

  /** Serialize admission globally; take DB time after obtaining the lock. */
  async create(): Promise<GuestAdmission> {
    const token = newGuestToken();
    const digest = guestTokenDigest(token);
    if (!digest) throw new Error('Could not generate guest credential');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(8071135)');
      const admitted = await client.query<GuestWorkspace>(
        `WITH instant AS (SELECT clock_timestamp() AS t)
         INSERT INTO guest_workspaces (id, token_sha256, created_at, expires_at)
         SELECT $1, $2, t, t + ($5::int * interval '1 hour') FROM instant
         WHERE (SELECT count(*) FROM guest_workspaces
                WHERE closed_at IS NULL AND expires_at > t) < $3::int
           AND (SELECT count(*) FROM guest_workspaces
                WHERE created_at > t - interval '1 hour') < $4::int
         RETURNING id, created_at, expires_at`,
        [
          randomUUID(),
          digest,
          guestSessionLimits.active,
          guestSessionLimits.startsPerHour,
          guestSessionLimits.ttlHours,
        ],
      );
      const workspace = admitted.rows[0];
      await client.query('COMMIT');
      return workspace ? { status: 'created', workspace, token } : { status: 'capacity' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findActive(token: unknown): Promise<GuestWorkspace | null> {
    const digest = guestTokenDigest(token);
    if (!digest) return null;
    const result = await this.pool.query<GuestWorkspace>(
      `SELECT id, created_at, expires_at FROM guest_workspaces
       WHERE token_sha256 = $1 AND closed_at IS NULL AND expires_at > clock_timestamp()`,
      [digest],
    );
    return result.rows[0] ?? null;
  }
}
