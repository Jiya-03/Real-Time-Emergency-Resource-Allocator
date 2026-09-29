// Generates the next ID in the dataset's style, e.g. UPD-010001, RSV-002116
// (Postgres: a per-table lock inside the transaction, so two servers never hand out the same ID)
export async function nextId(db, table, column, prefix, width) {
  if (db.driver === 'postgres') await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(table);
  const row = await db.prepare(
    `SELECT MAX(CAST(SUBSTR(${column}, ${prefix.length + 2}) AS INTEGER)) AS n FROM ${table}`
  ).get();
  return `${prefix}-${String((row.n || 0) + 1).padStart(width, '0')}`;
}
