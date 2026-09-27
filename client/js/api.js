// Shared helpers for every JeevanRoute page: API calls, session, formatting.
const API_BASE = '';   // same server that serves the UI (http://localhost:5000)

const Session = {
  KEY: 'jeevanroute.session',
  save(data, remember) {
    try {
      (remember ? localStorage : sessionStorage).setItem(this.KEY, JSON.stringify(data));
      (remember ? sessionStorage : localStorage).removeItem(this.KEY);
    } catch { /* private mode: session lives in memory only */ window.__session = data; }
  },
  get() {
    try {
      const raw = sessionStorage.getItem(this.KEY) || localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : window.__session || null;
    } catch { return window.__session || null; }
  },
  clear() {
    try { sessionStorage.removeItem(this.KEY); localStorage.removeItem(this.KEY); } catch {}
    window.__session = null;
  },
};

async function api(path, { method = 'GET', body } = {}) {
  const session = Session.get();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data.details || [];
    throw err;
  }
  return data;
}

const fmt = {
  // "13:42 IST"
  timeIST(iso) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' })
      .format(new Date(iso)) + ' IST';
  },
  // "28 Sep, 13:42 IST"
  dateTimeIST(iso) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' })
      .format(new Date(iso)) + ' IST';
  },
  // minutes since midnight in India (for "logged today")
  minutesSinceMidnightIST() {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' })
      .formatToParts(new Date());
    const get = (t) => Number(parts.find(p => p.type === t).value);
    return Math.max(1, get('hour') * 60 + get('minute'));
  },
  label(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  },
  escape(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
