// 火花签到 MVP —— 好友互签，连续共同打卡，超7天无互签清零
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// ---------- 工具 ----------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function genToken() { return crypto.randomBytes(24).toString('hex'); }
// 按时区偏移分钟数（相对UTC）计算本地日期 YYYY-MM-DD
function localDate(offsetMin) {
  const off = Number(offsetMin) || 0;
  return new Date(Date.now() + off * 60000).toISOString().slice(0, 10);
}
function daysBetween(a, b) { // a >= b
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name };
}

// 计算一对好友的火花状态
async function computeSpark(userId, otherId, tzOffsetMin) {
  const [setA, setB] = await Promise.all([
    db.checkinDates(userId), db.checkinDates(otherId),
  ]);
  const bSet = new Set(setB);
  const common = setA.filter(d => bSet.has(d)).sort();
  let days = common.length;
  let lastCommon = common.length ? common[common.length - 1] : null;
  let broken = false;
  if (lastCommon) {
    if (daysBetween(localDate(tzOffsetMin), lastCommon) > 7) { days = 0; broken = true; }
  }
  return { days, lastCommon, broken };
}

// ---------- 请求解析 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 路由 ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : {};

    // 注册
    if (req.method === 'POST' && p === '/api/register') {
      const { username, name, password, tzOffsetMin } = body;
      const uname = String(username || '').trim().toLowerCase();
      if (!uname || !name || !password || password.length < 4) {
        return json(res, 400, { error: '用户名/昵称必填，密码至少4位' });
      }
      if (await db.usernameExists(uname)) return json(res, 409, { error: '用户名已被占用' });
      const salt = crypto.randomBytes(8).toString('hex');
      const id = await db.createUser({
        username: uname, name: String(name),
        passHash: hashPassword(password, salt), salt, tzOffsetMin: Number(tzOffsetMin) || 0,
      });
      const token = genToken();
      await db.setToken(token, id);
      const user = await db.findById(id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    // 登录
    if (req.method === 'POST' && p === '/api/login') {
      const { username, password } = body;
      const uname = String(username || '').trim().toLowerCase();
      const user = await db.findByUsername(uname);
      if (!user || user.pass_hash !== hashPassword(password, user.salt)) {
        return json(res, 401, { error: '用户名或密码错误' });
      }
      const token = genToken();
      await db.setToken(token, user.id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    // 鉴权
    const token = body.token || url.searchParams.get('token');
    const meId = await db.userIdByToken(token);
    if (!meId) return json(res, 401, { error: '未登录或会话失效' });
    const me = await db.findById(meId);

    // 今日签到（服务端按时区算日期，一天一次，防作弊）
    if (req.method === 'POST' && p === '/api/checkin') {
      const offset = body.tzOffsetMin !== undefined ? Number(body.tzOffsetMin) : me.tz_offset_min;
      const date = localDate(offset);
      if (await db.hasCheckin(meId, date)) {
        return json(res, 409, { error: '今天已签过啦', localDate: date });
      }
      await db.addCheckin(meId, date);
      return json(res, 200, { ok: true, localDate: date });
    }

    // 加好友
    if (req.method === 'POST' && p === '/api/friend') {
      const uname = String(body.username || '').trim().toLowerCase();
      if (!uname) return json(res, 400, { error: '请填写对方用户名' });
      const target = await db.findByUsername(uname);
      if (!target) return json(res, 404, { error: '没找到这个用户' });
      if (target.id === meId) return json(res, 400, { error: '不能加自己为好友' });
      if (await db.friendshipExists(meId, target.id)) return json(res, 409, { error: '已经是好友啦' });
      await db.addFriendship(meId, target.id);
      return json(res, 200, { ok: true });
    }

    // 我的信息 + 好友火花
    if (req.method === 'GET' && p === '/api/me') {
      const fships = await db.friendshipsOf(meId);
      const today = localDate(me.tz_offset_min);
      const friends = [];
      for (const f of fships) {
        const otherId = f.ua === meId ? f.ub : f.ua;
        const other = await db.findById(otherId);
        const spark = await computeSpark(meId, otherId, me.tz_offset_min);
        friends.push({
          id: otherId, username: other.username, name: other.name,
          sparkDays: spark.days, lastCommon: spark.lastCommon, broken: spark.broken,
          todayChecked: await db.hasCheckin(meId, today),
        });
      }
      return json(res, 200, { user: publicUser(me), friends });
    }

    return json(res, 404, { error: '接口不存在' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

db.init()
  .then(() => {
    const server = http.createServer(handle);
    server.listen(PORT, () => {
      console.log('✅ 火花签到已启动' + (db.USE_PG ? '（使用 PostgreSQL）' : '（本地 JSON）'));
      console.log('  浏览器打开: http://localhost:' + PORT);
    });
  })
  .catch(e => { console.error('启动失败:', e.message); process.exit(1); });
