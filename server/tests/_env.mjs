// Imported first by every test: tests never touch your real data or Mapbox.
//   default           → a throw-away SQLite file per test
//   TEST_DATABASE_URL  → a throw-away Postgres database (it gets wiped!), e.g.
//                        TEST_DATABASE_URL=postgres://postgres@localhost:5433/jeevan_test npm test
// (Your server/.env DATABASE_URL / SUPABASE_* / MAPBOX_TOKEN are ignored here on purpose.)
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || '',
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', MAPBOX_TOKEN: '',
});
export const PG = !!process.env.DATABASE_URL;

// Run one SQL statement straight against the test database (SQLite file or Postgres), outside the server.
export async function directSql(dbPath, sql, params = []) {
  if (PG) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    let n = 0;
    try { await c.query(sql.replace(/\?/g, () => `$${++n}`), params); } finally { await c.end(); }
    return;
  }
  const { default: Database } = await import('better-sqlite3');
  const direct = new Database(dbPath);
  direct.prepare(sql).run(...params);
  direct.close();
}
