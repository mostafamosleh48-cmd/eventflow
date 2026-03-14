import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

dotenv.config();

import pool from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(): Promise<string[]> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY id'
  );
  return result.rows.map((row) => row.filename);
}

async function migrate(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('Running migrations...');

  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pending = files.filter((f) => !applied.includes(f));

  if (pending.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No pending migrations.');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    // eslint-disable-next-line no-console
    console.log(`Applying migration: ${file}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      // eslint-disable-next-line no-console
      console.log(`  Applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      // eslint-disable-next-line no-console
      console.error(`  Failed: ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Migrations complete. Applied ${String(pending.length)} migration(s).`);
  await pool.end();
}

migrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
