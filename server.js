const express = require('express');
const initSqlJs = require('sql.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_AUTH = process.env.ADMIN_AUTH || 'bank4444';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '9088145103:AAELJPuzEIHBC62jXdWKoMxvcTrKVwvbaW0';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '6148174309';

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN) { console.log('No TG_BOT_TOKEN set'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    console.log('TG send:', data.ok ? 'success' : data.description);
  } catch(e) { console.error('TG send error:', e); }
}
const DB_PATH = process.env.DB_PATH || 'bank4addicts.db';

let db;

async function initDB() {
  const SQL = await initSqlJs();
  try {
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
  } catch(e) {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      level TEXT DEFAULT 'unknown',
      score INTEGER DEFAULT 0,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      deposits INTEGER DEFAULT 0,
      relapses INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      last_clean_date TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  persist();
}

function persist() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch(e) { console.error('DB persist error:', e); }
}

function getOne(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function getAll(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params=[]) {
  db.run(sql, params);
  persist();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API ──

app.post('/api/account', (req, res) => {
  const { name, username, password, level, score } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  const existing = getOne('SELECT id FROM accounts WHERE username = ?', [username || '']);
  if (existing && username) return res.status(400).json({ error: 'username already taken ~ 🤭' });
  run('INSERT INTO accounts (name, username, password, level, score) VALUES (?, ?, ?, ?, ?)', [name, username || '', hashPw(password), level || 'unknown', score || 0]);
  const account = getOne('SELECT * FROM accounts ORDER BY id DESC LIMIT 1');
  sendTelegram(`🏦 <b>New Account Created</b>\n\n👤 <b>${username || name}</b>\n💊 Diagnosis: <b>${level}</b>\n📊 Score: <b>${score}</b>`);
  res.json(account);
});

app.post('/api/quiz-result', (req, res) => {
  const { username, score, level, answers } = req.body;
  const msg = `🏦 <b>New Quiz Result</b>\n\n` +
    `👤 <b>${username || 'anonymous'}</b>\n` +
    `📊 Score: <b>${score}/20</b>\n` +
    `💊 Diagnosis: <b>${level}</b>\n` +
    (answers ? `\n📝 Answers:\n${answers}` : '');
  sendTelegram(msg);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'fill in both fields ~ 🤭' });
  const account = getOne('SELECT * FROM accounts WHERE username = ?', [username]);
  if (!account) return res.json({ error: 'no account found ~ 🤭' });
  if (account.password !== hashPw(password)) return res.json({ error: 'wrong password ~ 🤭' });
  const now = new Date();
  const last = new Date(account.last_clean_date + 'Z');
  account.streak_days = Math.max(0, Math.floor((now - last) / (1000 * 60 * 60 * 24)));
  account.transactions = getAll('SELECT * FROM transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT 30', [account.id]);
  account.relapse_dates = getAll("SELECT date(created_at) as d FROM transactions WHERE account_id = ? AND type = 'relapse' ORDER BY created_at DESC LIMIT 60", [account.id]).map(r => r.d);
  delete account.password;
  res.json(account);
});

app.get('/api/account/:id', (req, res) => {
  const account = getOne('SELECT * FROM accounts WHERE id = ?', [+req.params.id]);
  if (!account) return res.status(404).json({ error: 'Not found' });
  const now = new Date();
  const last = new Date(account.last_clean_date + 'Z');
  account.streak_days = Math.max(0, Math.floor((now - last) / (1000 * 60 * 60 * 24)));
  account.transactions = getAll('SELECT * FROM transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT 30', [+req.params.id]);
  account.relapse_dates = getAll("SELECT date(created_at) as d FROM transactions WHERE account_id = ? AND type = 'relapse' ORDER BY created_at DESC LIMIT 60", [+req.params.id]).map(r => r.d);
  res.json(account);
});

app.post('/api/account/:id/deposit', (req, res) => {
  const { amount, note } = req.body;
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  run('UPDATE accounts SET balance = balance + ?, deposits = deposits + 1 WHERE id = ?', [amt, +req.params.id]);
  run('INSERT INTO transactions (account_id, type, amount, note) VALUES (?, ?, ?, ?)', [+req.params.id, 'deposit', amt, note || '']);
  const account = getOne('SELECT * FROM accounts WHERE id = ?', [+req.params.id]);
  res.json(account);
});

app.post('/api/account/:id/relapse', (req, res) => {
  const account = getOne('SELECT * FROM accounts WHERE id = ?', [+req.params.id]);
  if (!account) return res.status(404).json({ error: 'Not found' });
  const now = new Date();
  const last = new Date(account.last_clean_date + 'Z');
  const streak = Math.max(0, Math.floor((now - last) / (1000 * 60 * 60 * 24)));
  const newBest = Math.max(account.best_streak, streak);
  run("UPDATE accounts SET relapses = relapses + 1, best_streak = ?, last_clean_date = datetime('now') WHERE id = ?", [newBest, +req.params.id]);
  run('INSERT INTO transactions (account_id, type, amount, note) VALUES (?, ?, ?, ?)', [+req.params.id, 'relapse', 0, '']);
  res.json({ ok: true, streak_was: streak });
});

app.delete('/api/account/:id', (req, res) => {
  run('DELETE FROM transactions WHERE account_id = ?', [+req.params.id]);
  run('DELETE FROM accounts WHERE id = ?', [+req.params.id]);
  res.json({ ok: true });
});

// ── ADMIN ──

app.get('/admin', (req, res) => {
  if (req.query.auth !== ADMIN_AUTH) return res.send(adminLoginHTML());
  const accounts = getAll('SELECT * FROM accounts ORDER BY created_at DESC');
  const dep = getOne("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type = 'deposit'");
  const rel = getOne("SELECT COUNT(*) as total FROM transactions WHERE type = 'relapse'");
  res.send(adminHTML(accounts, dep ? dep.total : 0, rel ? rel.total : 0));
});

app.post('/admin/add-balance', (req, res) => {
  if (req.query.auth !== ADMIN_AUTH) return res.status(403).json({ error: 'Forbidden' });
  const { accountId, amount, note } = req.body;
  const amt = parseFloat(amount);
  if (!accountId || isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid' });
  run('UPDATE accounts SET balance = balance + ?, deposits = deposits + 1 WHERE id = ?', [amt, +accountId]);
  run('INSERT INTO transactions (account_id, type, amount, note) VALUES (?, ?, ?, ?)', [+accountId, 'deposit', amt, note || 'admin deposit']);
  res.json({ ok: true });
});

function adminLoginHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>
  body{font-family:system-ui;background:#0a0a0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:rgba(255,20,147,0.04);border:1px solid rgba(255,20,147,0.12);border-radius:16px;padding:32px;max-width:360px;width:90%;text-align:center}
  h2{color:#ff1493;margin-bottom:16px}
  input{width:100%;padding:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,20,147,0.2);border-radius:10px;color:#fff;font-size:15px;outline:none;margin:8px 0;text-align:center;box-sizing:border-box}
  button{width:100%;padding:12px;background:linear-gradient(135deg,#ff1493,#ff69b4);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
</style></head><body>
<div class="box"><h2>🏦 admin</h2>
<input id="pin" type="password" placeholder="pin ~" onkeydown="if(event.key==='Enter')go()">
<button onclick="go()">login</button>
</div>
<script>function go(){window.location='/admin?auth='+document.getElementById('pin').value}</script>
</body></html>`;
}

function adminHTML(accounts, totalDeposits, totalRelapses) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin — Bank4Addicts</title>
<style>
  body{font-family:system-ui;background:#0a0a0f;color:#eee;padding:20px;max-width:700px;margin:0 auto}
  h1{color:#ff1493;text-align:center}
  .card{background:rgba(255,20,147,0.04);border:1px solid rgba(255,20,147,0.12);border-radius:14px;padding:20px;margin:16px 0}
  .card h2{color:#ff69b4;font-size:14px;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px}
  .stats{display:flex;justify-content:space-around;text-align:center;padding:8px 0}
  .stat-num{font-size:24px;font-weight:700;color:#ff1493}
  .stat-label{font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:2px;margin-top:4px}
  select,input,button{padding:10px 14px;border-radius:10px;border:1px solid rgba(255,20,147,0.2);background:rgba(255,255,255,0.05);color:#eee;font-size:14px;margin:4px;box-sizing:border-box}
  select{width:100%;margin-bottom:8px}
  button{background:linear-gradient(135deg,#ff1493,#ff69b4);border:none;cursor:pointer;font-weight:600;color:#fff}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:rgba(255,255,255,0.4);font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:8px 6px;border-bottom:1px solid rgba(255,20,147,0.15)}
  td{padding:8px 6px;border-bottom:1px solid rgba(255,255,255,0.04)}
  .pink{color:#ff1493}
  .toast{position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-100px);background:rgba(255,20,147,0.9);color:#fff;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;z-index:999;transition:transform 0.4s}
  .toast.show{transform:translateX(-50%) translateY(0)}
</style></head><body>
<div class="toast" id="toast"></div>
<h1>🏦 bank4addicts admin</h1>
<div class="card">
  <div class="stats">
    <div><div class="stat-num">${accounts.length}</div><div class="stat-label">accounts</div></div>
    <div><div class="stat-num">$${(totalDeposits||0).toFixed(2)}</div><div class="stat-label">total deposited</div></div>
    <div><div class="stat-num">${totalRelapses||0}</div><div class="stat-label">total relapses</div></div>
  </div>
</div>
<div class="card">
  <h2>add balance</h2>
  <select id="acct">${accounts.map(a => `<option value="${a.id}">${a.name}${a.username?' ('+a.username+')':''} — $${(a.balance||0).toFixed(2)}</option>`).join('')}</select>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <input id="amt" type="number" step="0.01" placeholder="$0" style="flex:1;min-width:80px">
    <input id="note" type="text" placeholder="note (optional)" style="flex:2;min-width:120px">
    <button onclick="addBal()">add</button>
  </div>
</div>
<div class="card">
  <h2>accounts</h2>
  <table>
    <tr><th>name</th><th>username</th><th>diagnosis</th><th>balance</th><th>deposits</th><th>relapses</th><th>created</th></tr>
    ${accounts.map(a => `<tr>
      <td><strong>${a.name}</strong></td>
      <td class="pink" style="font-size:12px">${a.username||'-'}</td>
      <td style="font-size:11px;color:rgba(255,255,255,0.4)">${a.level}</td>
      <td class="pink">$${(a.balance||0).toFixed(2)}</td>
      <td>${a.deposits}</td>
      <td style="color:#ff4444">${a.relapses}</td>
      <td style="font-size:11px;color:rgba(255,255,255,0.3)">${a.created_at}</td>
    </tr>`).join('')}
  </table>
</div>
<script>
const auth='${ADMIN_AUTH}';
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000)}
function addBal(){
  const accountId=+document.getElementById('acct').value;
  const amount=document.getElementById('amt').value;
  const note=document.getElementById('note').value;
  if(!amount||parseFloat(amount)<=0){showToast('enter an amount ~');return}
  fetch('/admin/add-balance?auth='+auth,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId,amount,note})})
  .then(r=>r.json()).then(d=>{if(d.ok){showToast('$'+amount+' added ~');setTimeout(()=>location.reload(),800)}else showToast('error: '+d.error)});
}
</script>
</body></html>`;
}

// Start
initDB().then(() => {
  app.listen(PORT, () => console.log(`Bank4Addicts running on :${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
