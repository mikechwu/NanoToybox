/**
 * Schema assertion tests for the capsule_share table.
 *
 * Verifies that migration 0008 makes object_key nullable (the root
 * cause of the delete 500 incident) and that the delete core's
 * tombstone contract is compatible with the effective schema.
 *
 * Does NOT require a running SQLite/D1 instance — reads the migration
 * SQL files directly and verifies structural properties.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8');
}

describe('capsule_share schema (migration 0008)', () => {
  it('migration 0008 exists and defines object_key as nullable', () => {
    const sql = readMigration('0008_capsule_share_object_key_nullable.sql');

    // The rebuilt table must have `object_key TEXT` WITHOUT `NOT NULL`.
    // Match the column definition line in CREATE TABLE.
    const lines = sql.split('\n').map(l => l.trim());
    const objectKeyLine = lines.find(l =>
      l.startsWith('object_key') && l.includes('TEXT'),
    );
    expect(objectKeyLine).toBeDefined();
    // The SQL declaration part (before any --comment) must NOT contain NOT NULL.
    const sqlPart = objectKeyLine!.split('--')[0];
    expect(sqlPart).not.toMatch(/NOT\s+NULL/i);
  });

  it('migration 0008 rebuilds the table (DROP + RENAME pattern)', () => {
    const sql = readMigration('0008_capsule_share_object_key_nullable.sql');
    expect(sql).toContain('CREATE TABLE capsule_share_new');
    expect(sql).toContain('INSERT INTO capsule_share_new');
    expect(sql).toContain('DROP TABLE capsule_share');
    expect(sql).toContain('ALTER TABLE capsule_share_new RENAME TO capsule_share');
  });

  it('migration 0008 recreates all required indexes', () => {
    const sql = readMigration('0008_capsule_share_object_key_nullable.sql');
    expect(sql).toContain('CREATE UNIQUE INDEX idx_share_code');
    expect(sql).toContain('CREATE INDEX idx_status');
    expect(sql).toContain('CREATE INDEX idx_owner');
    expect(sql).toContain('CREATE INDEX idx_created');
    expect(sql).toContain('CREATE INDEX idx_capsule_object_key');
  });

  it('migration 0008 preserves all capsule_share columns from 0001', () => {
    const original = readMigration('0001_capsule_share.sql');
    const rebuild = readMigration('0008_capsule_share_object_key_nullable.sql');

    // Extract the capsule_share CREATE TABLE block only (stops at the
    // closing paren before the next CREATE statement).
    const tableMatch = original.match(/CREATE TABLE capsule_share \(([\s\S]*?)\);/);
    expect(tableMatch).not.toBeNull();
    const tableBody = tableMatch![1];

    const originalCols = tableBody.split('\n')
      .filter(l => l.trim().match(/^\w+\s+(TEXT|INTEGER|REAL)\b/))
      .map(l => l.trim().split(/\s/)[0]);

    expect(originalCols.length).toBeGreaterThan(10);
    for (const col of originalCols) {
      expect(rebuild).toContain(col);
    }
  });

  it('migration 0004 comment no longer falsely claims object_key is nullable in 0001', () => {
    const sql = readMigration('0004_capsule_delete_clears_body_metadata.sql');
    // The original false claim was: "object_key are already nullable in 0001"
    expect(sql).not.toMatch(/object_key\s+are\s+already\s+nullable/i);
    // The corrected comment should mention the error.
    expect(sql).toMatch(/object_key is NOT nullable in 0001/i);
  });

  it('base schema (0001) has object_key NOT NULL — confirming the bug source', () => {
    const sql = readMigration('0001_capsule_share.sql');
    expect(sql).toMatch(/object_key\s+TEXT\s+NOT\s+NULL/);
  });
});

describe('capsule-delete core contract vs schema', () => {
  it('delete core expects object_key to be nullable (SET object_key = NULL)', () => {
    const deleteCore = fs.readFileSync(
      path.resolve(__dirname, '../../src/share/capsule-delete.ts'),
      'utf-8',
    );
    expect(deleteCore).toContain('SET object_key = NULL');
  });

  it('delete-all endpoint does not leak raw error messages', () => {
    const deleteAll = fs.readFileSync(
      path.resolve(__dirname, '../../functions/api/account/capsules/delete-all.ts'),
      'utf-8',
    );
    expect(deleteAll).toContain("reason: 'delete_failed'");
    expect(deleteAll).not.toMatch(/failed\.push.*reason:\s*message/);
  });

  it('account-delete cascade does not leak raw error messages', () => {
    const accountDelete = fs.readFileSync(
      path.resolve(__dirname, '../../functions/api/account/delete.ts'),
      'utf-8',
    );
    expect(accountDelete).toContain("reason: 'delete_failed'");
    expect(accountDelete).not.toMatch(/failed\.push.*reason:\s*errorMessage/);
  });
});
