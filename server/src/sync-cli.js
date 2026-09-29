// npm run supabase:push   → wipe the Supabase tables and upload a fresh copy of the local database.
// npm run supabase:status → check the connection and show row counts in Supabase.
import './env.js';
import db from './db/index.js';
import { startSync, fullPush, stopSync } from './services/supabaseSync.js';

const cmd = process.argv[2] || 'status';
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env first (see server/.env.example).');
  process.exit(1);
}
const { createClient } = await import('@supabase/supabase-js');
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

if (cmd === 'push' && db.driver === 'postgres') {
  console.log('ℹ️  DATABASE_URL is set: the app already writes straight into Postgres/Supabase, nothing to push. Use `npm run seed` to reload the dataset there.');
} else if (cmd === 'push') {
  await db.prepare('UPDATE sync_state SET initialized = 1 WHERE id = 1').run();   // startSync must not auto-push twice
  await startSync({ client, noRealtime: true, noTimer: true });
  await fullPush();
  stopSync();
  console.log('✅ Supabase now matches the local database.');
} else {
  for (const t of ['hospitals', 'hospital_resources', 'hospital_services', 'emergency_requests', 'reservations', 'emergency_workflow_handover', 'admissions', 'ambulance_positions']) {
    const { count, error } = await client.from(t).select('*', { count: 'exact', head: true });
    console.log(error ? `❌ ${t}: ${error.message}${/does not exist|schema cache/.test(error.message) ? '  → run server/supabase/schema.sql in the Supabase SQL Editor' : ''}` : `✅ ${t}: ${count} rows`);
  }
}
process.exit(0);
