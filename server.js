const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PRIORITIES = 6;

/* ---------- хранилище: Postgres (DATABASE_URL) или JSON-файл для локального запуска ---------- */
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5
  });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS votes (
        cid TEXT PRIMARY KEY, p SMALLINT NOT NULL, d SMALLINT NOT NULL,
        r TEXT NOT NULL, i TEXT NOT NULL DEFAULT '', t BIGINT NOT NULL)`);
    },
    async list() {
      const { rows } = await pool.query('SELECT p, d, r, i, t FROM votes ORDER BY t DESC LIMIT 5000');
      return rows.map(x => ({ ...x, t: Number(x.t) }));
    },
    async save(cid, v) {
      await pool.query(
        `INSERT INTO votes (cid, p, d, r, i, t) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cid) DO UPDATE SET p=EXCLUDED.p, d=EXCLUDED.d, r=EXCLUDED.r, i=EXCLUDED.i, t=EXCLUDED.t`,
        [cid, v.p, v.d, v.r, v.i, v.t]
      );
    }
  };
} else {
  const file = path.join(__dirname, 'data', 'votes.json');
  let all = {};
  store = {
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { all = {}; }
      console.warn('DATABASE_URL не задан: ответы пишутся в data/votes.json (на бесплатном Render файл стирается при перезапуске).');
    },
    async list() { return Object.values(all).sort((a, b) => b.t - a.t).slice(0, 5000); },
    async save(cid, v) { all[cid] = v; fs.writeFileSync(file, JSON.stringify(all)); }
  };
}

/* ---------- сервер ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

// не больше 10 отправок в минуту с одного адреса
const hits = new Map();
const tooMany = ip => {
  const now = Date.now();
  const a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a);
  return a.length > 10;
};
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/votes', async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await store.list()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.post('/api/votes', async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'rate' });
  const b = req.body || {};
  const cid = typeof b.cid === 'string' && /^[\w-]{8,64}$/.test(b.cid) ? b.cid : null;
  const p = Number.isInteger(b.p) ? b.p : -1;
  const d = Number.isInteger(b.d) ? b.d : -1;
  const r = String(b.r || '').trim().slice(0, 40);
  const i = String(b.i || '').trim().slice(0, 200);
  if (!cid || p < 0 || p >= PRIORITIES || d < 0 || d > 100 || !r) return res.status(400).json({ error: 'bad' });
  try { await store.save(cid, { p, d, r, i, t: Date.now() }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.use(express.static(path.join(__dirname, 'public')));

store.init()
  .then(() => app.listen(PORT, () => console.log('Сайт запущен: http://localhost:' + PORT)))
  .catch(e => { console.error(e); process.exit(1); });
