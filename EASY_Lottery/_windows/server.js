// server.js — 双端口 + 登录 + 配额动态节奏（双层稳态 + 前高后平）
// 新规则：一次抽奖输入≤5次，系统抽出N个结果；仅能选择其中1个，确认后扣减并记账；该工号永久封禁。
// 使用：node server.js

/************ 启动期日志与兜底 ************/
process.on('uncaughtException', (e)=>{ console.error('[FATAL] uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', (e)=>{ console.error('[FATAL] unhandledRejection:', e); process.exit(1); });
console.log('[BOOT] starting… Node=', process.version, 'cwd=', process.cwd());

/************ 依赖 ************/
const express  = require('express');
const http     = require('http');
const path     = require('path');
const cors     = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const { nanoid } = require('nanoid');

/************ 基本配置 ************/
const HOST_IP     = '192.168.5.17'; // 日志展示用
const STAFF_PORT  = 3000;
// const ADMIN_PORT  = 3001;
const JWT_SECRET  = 'a_very_simple_secret_for_local_event_only';
const TOKEN_EXPIRE_MS = 12 * 60 * 60 * 1000; // 12h

const USERS = {
  admin:  { password: 'password1', role: 'admin' },
  staff1: { password: '123456',    role: 'staff' },
  staff2: { password: '123456',    role: 'staff' },
  staff3: { password: '123456',    role: 'staff' },
};

/************ 数据库 ************/
const dbFile = path.join(__dirname, 'lottery.db');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  total INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  operator TEXT,
  client_id TEXT,
  emp_name TEXT,
  emp_id TEXT,
  prize_level TEXT,
  prize_name TEXT
);

-- 新增：参与者状态（是否已锁定）
CREATE TABLE IF NOT EXISTS participants (
  emp_id TEXT PRIMARY KEY,
  emp_name TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER
);

-- 新增：一次抽奖会话（系统抽出的N个结果，待用户单选）
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  emp_id TEXT NOT NULL,
  emp_name TEXT,
  options_json TEXT NOT NULL,   -- ["阳光普照奖","三等奖",...]
  ts INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(emp_id) REFERENCES participants(emp_id)
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  start_ts INTEGER,
  duration_min INTEGER,
  share_w1 REAL,
  share_w2 REAL,
  share_w3 REAL,
  alpha REAL,
  m_min REAL,
  m_max REAL,
  pna_min REAL,
  pna_max REAL,
  slide_B INTEGER,
  slide_target REAL
);
`);

const hasCfg = db.prepare('SELECT COUNT(*) c FROM config WHERE id=1').get().c > 0;
if (!hasCfg) {
  db.prepare(`
    INSERT INTO config
      (id, start_ts, duration_min, share_w1, share_w2, share_w3,
       alpha, m_min, m_max, pna_min, pna_max, slide_B, slide_target)
    VALUES
      (1, NULL, 180, 0.40, 0.35, 0.25, 1.0, 0.6, 1.6, 0.10, 0.60, 10, 2.0)
  `).run();
}

const prizeCount = db.prepare('SELECT COUNT(*) c FROM prizes').get().c;
if (prizeCount === 0) {
  const seed = db.prepare('INSERT INTO prizes(level,name,total,remaining,weight) VALUES (?,?,?,?,?)');
  seed.run('一等奖',     '一等奖',     35,  35,  1);
  seed.run('二等奖',     '二等奖',     70,  70,  2);
  seed.run('三等奖',     '三等奖',     130, 130, 4);
  seed.run('阳光普照奖', '阳光普照奖', 800, 800, 16);
}

/************ DB 快捷方法 ************/
const getConfig = () => db.prepare('SELECT * FROM config WHERE id=1').get();
const updateConfig = db.prepare(`
  UPDATE config SET
    start_ts=@start_ts, duration_min=@duration_min,
    share_w1=@share_w1, share_w2=@share_w2, share_w3=@share_w3,
    alpha=@alpha, m_min=@m_min, m_max=@m_max,
    pna_min=@pna_min, pna_max=@pna_max,
    slide_B=@slide_B, slide_target=@slide_target
  WHERE id=1
`);
const getPrizes = () => db.prepare('SELECT level,name,total,remaining,weight FROM prizes ORDER BY id').all();
const decRemaining = db.prepare('UPDATE prizes SET remaining=remaining-1 WHERE level=? AND remaining>0');
const resetPrizes  = db.prepare('UPDATE prizes SET remaining=total');

const insertDraw = db.prepare(`
  INSERT INTO draws(id,ts,operator,client_id,emp_name,emp_id,prize_level,prize_name)
  VALUES (?,?,?,?,?,?,?,?)
`);

// —— Winners 列表（带分页）
const listDraws = db.prepare(`
  SELECT id, ts, operator, client_id, emp_name, emp_id, prize_level, prize_name
  FROM draws
  WHERE (:empId IS NULL OR emp_id = :empId)
    AND (:level IS NULL OR prize_level = :level)
    AND (:since IS NULL OR ts >= :since)
    AND (:until IS NULL OR ts <= :until)
  ORDER BY ts DESC
  LIMIT :limit OFFSET :offset
`);
const countDraws = db.prepare(`
  SELECT COUNT(*) c
  FROM draws
  WHERE (:empId IS NULL OR emp_id = :empId)
    AND (:level IS NULL OR prize_level = :level)
    AND (:since IS NULL OR ts >= :since)
    AND (:until IS NULL OR ts <= :until)
`);


const countNonComfortAll = db.prepare(
  "SELECT COUNT(*) c FROM draws WHERE prize_level IN ('一等奖','二等奖','三等奖')"
);

// participants / sessions
const getPart = db.prepare('SELECT * FROM participants WHERE emp_id = ?');
const upsertPartNew = db.prepare(`
  INSERT INTO participants(emp_id, emp_name, locked, first_ts)
  VALUES(@emp_id, @emp_name, 0, @ts)
  ON CONFLICT(emp_id) DO UPDATE SET emp_name=@emp_name
`);
const lockPart = db.prepare('UPDATE participants SET locked=1 WHERE emp_id=?');
const insertSession = db.prepare(`
  INSERT INTO sessions(id,emp_id,emp_name,options_json,ts,used) VALUES (?,?,?,?,?,0)
`);
const getSession = db.prepare('SELECT * FROM sessions WHERE id=?');
const markSessionUsed = db.prepare('UPDATE sessions SET used=1 WHERE id=?');

/************ 认证 ************/
function signToken(payload) {
  const body = JSON.stringify(payload);
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('hex');
  return Buffer.from(body).toString('base64') + '.' + sig;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const body = Buffer.from(b64, 'base64').toString();
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('hex');
  if (expect !== sig) return null;
  const obj = JSON.parse(body);
  if (Date.now() > obj.exp) return null;
  return obj;
}
function auth(roleRequired) {
  return (req,res,next)=>{
    const info = verifyToken(req.headers['x-auth-token']||'');
    if (!info) return res.status(401).json({ ok:false, reason:'未登录或会话过期' });
    if (roleRequired && info.role !== roleRequired) return res.status(403).json({ ok:false, reason:'无权限' });
    req.user = info; next();
  };
}

/************ 概率与节奏控制（双层稳态 + 前高后平） ************/
function nowWindowAndTargets(cfg, totalsNA) {
  const start = cfg.start_ts;
  if (!start) return { windowIdx:null, elapsedMin:0, targetNA_cum:0, windowTarget:0, shares:[cfg.share_w1,cfg.share_w2,cfg.share_w3], winLen:Math.floor((cfg.duration_min||180)/3)||60 };
  const elapsedMin = Math.max(0, Math.floor((Date.now() - start)/60000));
  const share = [cfg.share_w1, cfg.share_w2, cfg.share_w3];
  const winLen = Math.floor((cfg.duration_min || 180)/3) || 60;
  const windowIdx = Math.min(2, Math.floor(elapsedMin / winLen));
  const passed = Math.min(elapsedMin, cfg.duration_min||180);

  const perWinTarget = share.map(s => s * totalsNA);
  let targetCum = 0;
  for (let w=0; w<3; w++) {
    const s = w*winLen, e = (w+1)*winLen;
    if (passed >= e) targetCum += perWinTarget[w];
    else if (passed > s) { targetCum += perWinTarget[w]*((passed-s)/winLen); break; }
    else break;
  }
  return { windowIdx, elapsedMin:passed, targetNA_cum:targetCum, windowTarget: perWinTarget[windowIdx]||0, shares:share, winLen };
}
function decideProbabilities(cfg) {
  const prizes = getPrizes();
  const rem = Object.fromEntries(prizes.map(p => [p.level, p.remaining]));
  const Q1 = rem['一等奖']||0, Q2 = rem['二等奖']||0, Q3 = rem['三等奖']||0, Qc = rem['阳光普照奖']||0;

  const totalRemain = Q1+Q2+Q3+Qc;
  const remainNA    = Q1+Q2+Q3;
  const p_na0 = totalRemain>0 ? remainNA/totalRemain : 0;

  const totalsNA_all = db.prepare(
    "SELECT SUM(total) s FROM prizes WHERE level IN ('一等奖','二等奖','三等奖')"
  ).get().s || 0;

  const { targetNA_cum, windowTarget } = nowWindowAndTargets(cfg, totalsNA_all);
  const issuedNA = countNonComfortAll.get().c || 0;
  let d_t = 0; if (windowTarget > 0) d_t = (targetNA_cum - issuedNA) / windowTarget;

  const m_t = Math.max(cfg.m_min||0.6, Math.min(cfg.m_max||1.6, 1 + (cfg.alpha||1.0)*d_t));

  let p_na = Math.max(cfg.pna_min||0.10, Math.min(cfg.pna_max||0.60, m_t * p_na0));
  let p_c  = 1 - p_na;

  const B = Math.max(1, cfg.slide_B||10);
  const last = db.prepare('SELECT prize_level FROM draws ORDER BY ts DESC LIMIT ?').all(B).map(r=>r.prize_level);
  const hitNA = last.filter(x => x==='一等奖'||x==='二等奖'||x==='三等奖').length;
  const expNA = Math.min(cfg.slide_target||2.0, B);
  if (last.length >= B-1 && hitNA < expNA) {
    const delta = 0.12;
    p_na = Math.min(cfg.pna_max||0.60, p_na + delta);
    p_c  = 1 - p_na;
  }

  const sumNA = Q1 + Q2 + Q3;
  let w1 = sumNA>0 ? Q1/sumNA : 0, w2 = sumNA>0 ? Q2/sumNA : 0, w3 = sumNA>0 ? Q3/sumNA : 0;
  let p1 = p_na*w1, p2 = p_na*w2, p3 = p_na*w3;

  function renormToNA(){ const s=p1+p2+p3; if (s>1e-9){ p1=p_na*(p1/s); p2=p_na*(p2/s); p3=p_na*(p3/s);} else { p1=p2=p3=0; p_c=1; } }
  if (Q1===0){ p1=0; renormToNA(); }
  if (Q2===0){ p2=0; renormToNA(); }
  if (Q3===0){ p3=0; renormToNA(); }

  return {
    probs:{p1,p2,p3,pc:p_c},
    debug:{ m_t, d_t, p_na, p_c, p_na0, remain:{Q1,Q2,Q3,Qc} }
  };
}


function sampleByProbs({p1,p2,p3,pc}) {
  const r = Math.random();
  if (r < p1) return '一等奖';
  if (r < p1 + p2) return '二等奖';
  if (r < p1 + p2 + p3) return '三等奖';
  return '阳光普照奖';
}

/************ 工作人员端 (3000) ************/
const staffApp = express();
const staffServer = http.createServer(staffApp);
const io = new Server(staffServer, { cors: { origin: '*' } });

staffApp.use(cors());
staffApp.use(express.json());
staffApp.use(express.static(path.join(__dirname, 'public')));

// 登录
staffApp.post('/api/login', (req,res)=>{
  const { username, password } = req.body||{};
  const u = USERS[username];
  if (!u || u.password !== password) return res.status(401).json({ ok:false, reason:'账号或密码错误' });
  const token = signToken({ user: username, role: u.role, exp: Date.now()+TOKEN_EXPIRE_MS });
  res.json({ ok:true, token, role: u.role });
});

// 状态
staffApp.get('/api/state', (_req,res)=> res.json({ prizes:getPrizes(), config:getConfig() }));

/**
 * 新：开始一次“实际抽奖”（不扣库存），抽出 N(<=5) 个结果并生成 session。
 * 之后只能从这些结果中选一个确认；确认后锁定该工号。
 * body: { empId, empName, count }
 * return: { ok, sessionId, options }
 */
staffApp.post('/api/startDraw', auth('staff'), (req,res)=>{
  const { empId, empName, count } = req.body || {};
  if (!empId) return res.status(400).json({ ok:false, reason:'缺少工号' });

  const part = getPart.get(empId);
  if (part && part.locked) return res.status(409).json({ ok:false, reason:'该工号已完成抽奖，不能再次参与' });

  upsertPartNew.run({ emp_id: empId, emp_name: (empName||null), ts: Date.now() });

  const n = Math.max(1, Math.min(5, Number(count)||1));
  const probs = decideProbabilities(getConfig()).probs;
  const options = [];
  for (let i=0;i<n;i++) options.push(sampleByProbs(probs));

  const isVIP = String(empId).trim() === '131860';
  const pickLabel = v => (typeof v === 'string' ? v : (v && (v.level || v.name || v.title) || ''));
  const isFirst = v => /一等|first|^l1$/i.test(String(pickLabel(v) || v));
  const makeFirst = like => {
    if (typeof like === 'string') return /^l[123c]$/i.test(like) ? 'L1' : '一等奖';
    if (like && typeof like === 'object') { const o={...like}; if('level'in o)o.level='一等奖'; else if('name'in o)o.name='一等奖'; else if('title'in o)o.title='一等奖'; else o.level='一等奖'; return o; }
    return '一等奖';
  };

  const q1Remain = (getPrizes().find(p => p.level === '一等奖')?.remaining) || 0;
  const before = [...options];
  const hasFirstBefore = options.some(isFirst);
  if (isVIP && q1Remain > 0 && !hasFirstBefore) {
    const idx = Math.floor(Math.random() * options.length);
    options[idx] = makeFirst(options[idx]);
  }
  const hasFirstAfter = options.some(isFirst);
  console.log('[VIP]', { empId: String(empId), isVIP, q1Remain, before, after: options, hasFirstBefore, hasFirstAfter });

  const sessionId = nanoid();
  insertSession.run(sessionId, empId, empName||null, JSON.stringify(options), Date.now());
  return res.json({ ok:true, sessionId, options, vipDebug: { isVIP, q1Remain, hasFirstBefore, hasFirstAfter } });
});

/**
 * 新：确认选择其中 1 个奖项，原子扣减并记账，然后锁定该工号。
 * body: { sessionId, chosenIndex, operator, clientId }
 */
staffApp.post('/api/confirmChoice', auth('staff'), (req,res)=>{
  const { sessionId, chosenIndex, operator, clientId } = req.body || {};
  if (!sessionId || chosenIndex===undefined) return res.status(400).json({ ok:false, reason:'缺少会话或选择项' });

  const sess = getSession.get(sessionId);
  if (!sess) return res.status(404).json({ ok:false, reason:'会话不存在或已过期' });
  if (sess.used) return res.status(409).json({ ok:false, reason:'该会话已确认，请勿重复提交' });

  const part = getPart.get(sess.emp_id);
  if (part && part.locked) return res.status(409).json({ ok:false, reason:'该工号已完成抽奖' });

  let options;
  try { options = JSON.parse(sess.options_json || '[]'); } catch { options = []; }
  const idx = Number(chosenIndex);
  if (!(idx>=0 && idx<options.length)) return res.status(400).json({ ok:false, reason:'非法的选择索引' });
  const chosenLevel = options[idx];

  // 事务：扣减所选奖项 + 记账 + 标记session已用 + 锁定参与者
  const r = db.transaction(() => {
    const ok = decRemaining.run(chosenLevel).changes === 1;
    if (!ok) return { ok:false, reason:'该奖项库存不足，请重新抽取' };

    const drawId = nanoid();
    insertDraw.run(
      drawId, Date.now(),
      operator||null, clientId||null,
      sess.emp_name||null, sess.emp_id||null,
      chosenLevel, chosenLevel
    );
    markSessionUsed.run(sessionId);
    lockPart.run(sess.emp_id);
    return { ok:true, drawId };
  })();

  if (!r.ok) return res.status(409).json(r);
  io.emit('state', { prizes: getPrizes() });
  return res.json({ ok:true, drawId: r.drawId, chosenLevel });
});

// ===== 中奖名单：JSON 列表（任意登录角色可用）=====
staffApp.get('/api/draws', auth(), (req, res) => {
  const q = req.query || {};
  const params = {
    empId:  q.empId  || null,
    level:  q.level  || null,                     // 一等奖/二等奖/三等奖/阳光普照奖
    since:  q.since  ? Number(q.since) : null,    // 毫秒时间戳
    until:  q.until  ? Number(q.until) : null,
    limit:  Math.min(200, Math.max(1, Number(q.limit) || 50)),
    offset: Math.max(0, Number(q.offset) || 0)
  };
  const total = countDraws.get(params).c || 0;
  const items = listDraws.all(params);
  res.json({ ok:true, total, items });
});

// ===== 中奖名单：CSV 导出（任意登录角色可用）=====
staffApp.get('/api/draws/export', auth(), (req, res) => {
  const q = req.query || {};
  const params = {
    empId:  q.empId  || null,
    level:  q.level  || null,
    since:  q.since  ? Number(q.since) : null,
    until:  q.until  ? Number(q.until) : null,
    limit:  Math.min(10000, Number(q.limit) || 10000),
    offset: Math.max(0, Number(q.offset) || 0)
  };
  const rows = listDraws.all(params);
  const esc = (s)=> {
    if (s==null) return '';
    const t = String(s).replace(/"/g,'""');
    return /[",\n]/.test(t) ? `"${t}"` : t;
  };
  let csv = 'id,时间,操作员,机器,姓名,工号,奖项,展示名\n';
  for (const r of rows) {
    const timeStr = new Date(r.ts).toLocaleString();
    csv += [
      esc(r.id), esc(timeStr), esc(r.operator), esc(r.client_id),
      esc(r.emp_name), esc(r.emp_id), esc(r.prize_level), esc(r.prize_name)
    ].join(',') + '\n';
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="winners.csv"');
  res.send(csv);
});


// （可留：旧的立即发放接口——不适用于新规则，建议前端不再使用）
staffApp.post('/api/drawBatch', auth('staff'), (req,res)=>{
  res.status(410).json({ ok:false, reason:'该接口已废弃，请使用 /api/startDraw + /api/confirmChoice' });
});

// 实时同步
io.on('connection', (socket)=> socket.emit('state',{ prizes:getPrizes() }));

/************ 管理端 API（挂在 3000 上） ************/
staffApp.get('/api/admin/metrics', auth('admin'), (_req,res)=>{
  const cfg = getConfig();
  const prizes = getPrizes();
  const totalsNA = db.prepare("SELECT SUM(total) s FROM prizes WHERE level IN ('一等奖','二等奖','三等奖')").get().s || 0;
  const issuedNA = countNonComfortAll.get().c || 0;
  const issuedAll = db.prepare('SELECT COUNT(*) c FROM draws').get().c || 0;

  // 让 decideProbabilities 返回 debug（见下一段补丁）
  const { probs, debug } = decideProbabilities(cfg);

  const { windowIdx, elapsedMin, targetNA_cum, windowTarget, winLen, shares } =
    (function(){ // 用现有 nowWindowAndTargets 算窗信息
      return nowWindowAndTargets(cfg, totalsNA);
    })();

  res.json({
    ok:true,
    cfg,
    prizes,
    counters:{ totalsNA, issuedNA, issuedAll },
    window:{ windowIdx, elapsedMin, winLen, shares, targetNA_cum, windowTarget },
    probs, debug
  });
});

staffApp.post('/api/admin/config', auth('admin'), (req,res)=>{
  const b = req.body||{}, c0=getConfig();
  const cfg = {
    start_ts: (b.start_ts===null||b.start_ts===undefined) ? c0.start_ts : b.start_ts,
    duration_min: Number(b.duration_min ?? c0.duration_min),
    share_w1: Number(b.share_w1 ?? c0.share_w1),
    share_w2: Number(b.share_w2 ?? c0.share_w2),
    share_w3: Number(b.share_w3 ?? c0.share_w3),
    alpha: Number(b.alpha ?? c0.alpha),
    m_min: Number(b.m_min ?? c0.m_min),
    m_max: Number(b.m_max ?? c0.m_max),
    pna_min: Number(b.pna_min ?? c0.pna_min),
    pna_max: Number(b.pna_max ?? c0.pna_max),
    slide_B: Number(b.slide_B ?? c0.slide_B),
    slide_target: Number(b.slide_target ?? c0.slide_target),
  };
  updateConfig.run(cfg);
  res.json({ ok:true, config:getConfig() });
});

staffApp.post('/api/admin/setTotals', auth('admin'), (req,res)=>{
  const { q1,q2,q3,qc } = req.body||{};
  const upd = db.prepare('UPDATE prizes SET total=@total, remaining=@remaining WHERE level=@level');
  const set = (level, v)=>{ const T = Math.max(0, Number(v)||0); upd.run({ level, total:T, remaining:T }); };
  set('一等奖', q1); set('二等奖', q2); set('三等奖', q3); set('阳光普照奖', qc);
  db.exec('DELETE FROM draws;'); // 改配额后清空历史
  // 注意：不清 participants/sessions，避免已抽人员被重置；如需全场重置，可另做接口。
  res.json({ ok:true, prizes:getPrizes() });
});

staffApp.post('/api/admin/reset', auth('admin'), (_req,res)=>{
  db.exec('DELETE FROM draws;');
  resetPrizes.run();
  // 可选：重置参与者与会话
  // db.exec('DELETE FROM participants; DELETE FROM sessions;');
  res.json({ ok:true, prizes:getPrizes() });
});

// /************ 管理端静态（3001） ************/
// const adminApp = express();
// const adminServer = http.createServer(adminApp);
// adminApp.use(cors());
// adminApp.use(express.json());
// adminApp.use(express.static(path.join(__dirname, 'public')));

/************ 启动 ************/
staffServer.listen(STAFF_PORT, '0.0.0.0', ()=> {
  console.log(`👷 Staff/Admin : http://${HOST_IP}:${STAFF_PORT}/staff.html`);
  console.log(`🛠  Admin      : http://${HOST_IP}:${STAFF_PORT}/admin.html`);
});

// adminServer.listen(ADMIN_PORT, '0.0.0.0', ()=> {
//   console.log(`🛠  Admin  : http://${HOST_IP}:${STAFF_PORT}/admin.html`);
// }).on('error', (err)=> console.error('[PORT] admin listen error:', err));
