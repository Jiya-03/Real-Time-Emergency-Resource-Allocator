# Supabase live database (two-way sync)

The app keeps its fast local database (that's what guarantees no double-booking) and mirrors
**everything** to Supabase live. Supabase becomes the shared dashboard where you can **view, create,
edit and delete** data, and watch the backend change in real time.

| Direction | What | How fast |
|---|---|---|
| App → Supabase | hospitals, beds, departments, emergencies, bed holds, hospital answers, handovers, admissions, bed-change history, rankings, **live ambulance positions** | ~1 second |
| Supabase → App | anything you create / edit / delete in `hospitals`, `hospital_resources`, `hospital_services` | instant (Realtime) |

## One-time setup (≈5 minutes)
1. Create a free project at <https://supabase.com> → **New project** (region: Mumbai / `ap-south-1`).
2. **SQL Editor → New query**: paste all of `server/supabase/schema.sql` → **Run**.
3. **Project Settings → API**: copy **Project URL** and the **service_role** key.
4. In `server/.env` (copy from `.env.example` if needed):
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
5. `npm install` then `npm run dev`. The first start uploads the whole database (you'll see
   `🟢 [supabase] Full sync done` and `Realtime connected`).

Check any time: `npm run supabase:status` or <http://localhost:5000/api/config/sync>.

## What you can do in Supabase (Table Editor)
- **Add a hospital**: insert a row in `hospitals` (e.g. `HSP-026`). The app creates empty bed and department
  rows for it; fill in `hospital_resources` (totals / available) and `hospital_services` (1 = available).
  It appears in dispatcher matching immediately.
- **Edit beds / departments**: change any number or 0/1 flag. Every open screen updates live; the change
  is recorded as an **Admin** update.
- **Delete a hospital**: hospitals without emergency history are removed from the app; ones with history
  are **deactivated** (kept for the records) and come back with `active_status = 0`.
- **Invalid edits** (e.g. available > total) are rejected and Supabase is put back automatically.
- **Live tracking views**: open `live_emergencies` (active cases, which hospital accepted, ambulance
  position + ETA, bed allocated) and `live_hospital_capacity` (beds, departments, data age).
  `ambulance_positions` updates every few seconds while an ambulance is driving.
- Emergencies / holds / handovers are **mirrored read-only**: change them through the app so the booking
  rules stay enforced (edits there are overwritten on the next sync).

## Commands
| Command | What it does |
|---|---|
| `npm run supabase:status` | Tests the connection and shows row counts |
| `npm run supabase:push` | Wipes the Supabase tables and uploads a fresh copy of the local database |
| `npm run seed` | Resets the local database; Supabase is refreshed automatically on the next server start |

## Security
- Row Level Security is **on** for every table with no public policies: only the server (service_role key)
  can read/write. The public anon key sees nothing.
- Never commit `server/.env` or put the service_role key in the browser.
