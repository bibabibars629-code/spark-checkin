// 数据访问层：有 DATABASE_URL 用 PostgreSQL，否则用本地 JSON 文件
// 这样本地开发 / 部署到 Render(连数据库) 都能跑
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');
const USE_PG = !!process.env.DATABASE_URL;

let pool = null;
if (USE_PG) {
  try {
    const pg = require('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  } catch (e) {
    console.error('未安装 pg 依赖，请先 npm install pg');
    process.exit(1);
  }
}

// ---------- JSON 后端 ----------
let mem = null;
function loadJson() {
  if (!mem) {
    try { mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { mem = { users: {}, tokens: {}, friendships: [], checkins: {} }; }
  }
  return mem;
}
function saveJson() { fs.writeFileSync(DATA_FILE, JSON.stringify(loadJson(), null, 2)); }

// ---------- 初始化 ----------
async function init() {
  if (USE_PG) {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, username text UNIQUE, name text,
      pass_hash text, salt text, tz_offset_min int, created_at text)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tokens (token text PRIMARY KEY, user_id text)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS friendships (
      id text PRIMARY KEY, ua text, ub text, created_at text)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS checkins (
      user_id text, local_date text, PRIMARY KEY (user_id, local_date))`);
  } else {
    loadJson();
  }
}

// ---------- 用户 ----------
function newId() { return crypto.randomUUID(); }

async function createUser({ username, name, passHash, salt, tzOffsetMin }) {
  const id = newId();
  if (USE_PG) {
    await pool.query(
      `INSERT INTO users(id, username, name, pass_hash, salt, tz_offset_min, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, username, name, passHash, salt, tzOffsetMin, new Date().toISOString()]
    );
  } else {
    const d = loadJson();
    d.users[id] = { id, username, name, passHash, salt, tzOffsetMin, createdAt: new Date().toISOString() };
    saveJson();
  }
  return id;
}

async function findByUsername(username) {
  if (USE_PG) {
    const r = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
    return r.rows[0] || null;
  }
  return Object.values(loadJson().users).find(u => u.username === username) || null;
}

async function findById(id) {
  if (USE_PG) {
    const r = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    return r.rows[0] || null;
  }
  return loadJson().users[id] || null;
}

async function usernameExists(username) {
  return !!(await findByUsername(username));
}

// ---------- 会话 ----------
async function setToken(token, userId) {
  if (USE_PG) {
    await pool.query(`INSERT INTO tokens(token, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [token, userId]);
  } else {
    const d = loadJson(); d.tokens[token] = userId; saveJson();
  }
}
async function userIdByToken(token) {
  if (USE_PG) {
    const r = await pool.query(`SELECT user_id FROM tokens WHERE token=$1`, [token]);
    return r.rows[0] ? r.rows[0].user_id : null;
  }
  return loadJson().tokens[token] || null;
}

// ---------- 好友 ----------
async function addFriendship(ua, ub) {
  if (USE_PG) {
    await pool.query(`INSERT INTO friendships(id, ua, ub, created_at) VALUES($1,$2,$3,$4)`,
      [newId(), ua, ub, new Date().toISOString()]);
  } else {
    const d = loadJson();
    d.friendships.push({ id: newId(), ua, ub, createdAt: new Date().toISOString() });
    saveJson();
  }
}
async function friendshipExists(ua, ub) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT 1 FROM friendships WHERE (ua=$1 AND ub=$2) OR (ua=$2 AND ub=$1)`, [ua, ub]);
    return r.rowCount > 0;
  }
  return loadJson().friendships.some(f => (f.ua === ua && f.ub === ub) || (f.ua === ub && f.ub === ua));
}
async function friendshipsOf(userId) {
  if (USE_PG) {
    const r = await pool.query(`SELECT * FROM friendships WHERE ua=$1 OR ub=$1`, [userId]);
    return r.rows;
  }
  return loadJson().friendships.filter(f => f.ua === userId || f.ub === userId);
}

// ---------- 签到 ----------
async function hasCheckin(userId, date) {
  if (USE_PG) {
    const r = await pool.query(`SELECT 1 FROM checkins WHERE user_id=$1 AND local_date=$2`, [userId, date]);
    return r.rowCount > 0;
  }
  return !!(loadJson().checkins[userId] || {})[date];
}
async function addCheckin(userId, date) {
  if (USE_PG) {
    await pool.query(`INSERT INTO checkins(user_id, local_date) VALUES($1,$2) ON CONFLICT DO NOTHING`, [userId, date]);
  } else {
    const d = loadJson();
    if (!d.checkins[userId]) d.checkins[userId] = {};
    d.checkins[userId][date] = true;
    saveJson();
  }
}
async function checkinDates(userId) {
  if (USE_PG) {
    const r = await pool.query(`SELECT local_date FROM checkins WHERE user_id=$1`, [userId]);
    return r.rows.map(x => x.local_date);
  }
  return Object.keys(loadJson().checkins[userId] || {});
}

module.exports = {
  USE_PG, init,
  createUser, findByUsername, findById, usernameExists,
  setToken, userIdByToken,
  addFriendship, friendshipExists, friendshipsOf,
  hasCheckin, addCheckin, checkinDates,
};
