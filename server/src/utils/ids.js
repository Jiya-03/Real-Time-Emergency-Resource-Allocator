// Generates the next ID in the dataset's style, e.g. UPD-010001, RSV-002116
export function nextId(db, table, column, prefix, width) {
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(${column}, ${prefix.length + 2}) AS INTEGER)) AS n FROM ${table}`
  ).get();
  return `${prefix}-${String((row.n || 0) + 1).padStart(width, '0')}`;
}
