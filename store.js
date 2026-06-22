// GENER8 — Postgres data-access layer (multi-tenant)
//
// One module that owns ALL persistence. The rest of the app calls these methods
// instead of touching a global object, so writes are atomic and safe across
// concurrent requests and (with Postgres) across multiple server instances.
//
// Production: a real Postgres pool from DATABASE_URL.
// Tests: a pg-mem pool can be injected, so the SQL is validated without a server.

import crypto from "node:crypto";
import fs from "node:fs";

export function ym(d = new Date()) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
export function rid(n = 12) { return crypto.randomBytes(n).toString("hex"); }
export function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex") };
}
export function verifyPw(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pw), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch { return false; }
}

// ---- secret-at-rest encryption for per-tenant API keys ----------------------
const APP_SECRET = process.env.APP_SECRET || "";
const ENC_KEY = APP_SECRET ? crypto.scryptSync(APP_SECRET, "gener8-keys", 32) : null;
export function encryptSecret(text) {
  if (text == null || text === "") return null;
  if (!ENC_KEY) return "plain:" + text; // no APP_SECRET set — stored as-is (warned at boot)
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return "enc:" + Buffer.concat([iv, tag, enc]).toString("base64");
}
export function decryptSecret(stored) {
  if (!stored) return null;
  if (stored.startsWith("plain:")) return stored.slice(6);
  if (!stored.startsWith("enc:") || !ENC_KEY) return null;
  try {
    const raw = Buffer.from(stored.slice(4), "base64");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch { return null; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active',
  settings text NOT NULL DEFAULT '{}', gemini_key text, eleven_key text, created_at bigint
);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, tenant_id text, email text UNIQUE NOT NULL,
  password_hash text, salt text, role text NOT NULL DEFAULT 'user',
  credits bigint NOT NULL DEFAULT 0, credits_month text, created_at bigint
);
CREATE TABLE IF NOT EXISTS sessions ( token text PRIMARY KEY, user_id text, expires bigint );
CREATE TABLE IF NOT EXISTS feed ( id text PRIMARY KEY, tenant_id text, user_id text, data text NOT NULL, created_at bigint );
CREATE TABLE IF NOT EXISTS media ( file text PRIMARY KEY, tenant_id text, user_id text, created_at bigint );
CREATE TABLE IF NOT EXISTS usage_stats ( user_id text, tenant_id text, month text, images int DEFAULT 0, videos int DEFAULT 0, vo int DEFAULT 0, music int DEFAULT 0, credits bigint DEFAULT 0, usd double precision DEFAULT 0, PRIMARY KEY (user_id, month) );
CREATE TABLE IF NOT EXISTS voice_adds ( tenant_id text, k text, voice_id text, last_used bigint, PRIMARY KEY (tenant_id, k) );
CREATE INDEX IF NOT EXISTS idx_feed_user ON feed(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_tenant ON feed(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
`;

export function makeStore(pool) {
  const q = (text, params) => pool.query(text, params);

  const store = {
    pool,
    async initSchema() { for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await q(stmt); },

    // ---- tenants ----
    async createTenant({ id = rid(), name, settings = {}, geminiKey = null, elevenKey = null, status = "active" }) {
      await q("INSERT INTO tenants (id,name,status,settings,gemini_key,eleven_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, name, status, JSON.stringify(settings), encryptSecret(geminiKey), encryptSecret(elevenKey), Date.now()]);
      return store.getTenant(id);
    },
    async getTenant(id) {
      const r = await q("SELECT * FROM tenants WHERE id=$1", [id]);
      return r.rows[0] ? hydrateTenant(r.rows[0]) : null;
    },
    async listTenants() { const r = await q("SELECT * FROM tenants ORDER BY created_at ASC", []); return r.rows.map(hydrateTenant); },
    async updateTenant(id, fields) {
      const sets = [], vals = []; let i = 1;
      if (fields.name != null) { sets.push(`name=$${i++}`); vals.push(fields.name); }
      if (fields.status != null) { sets.push(`status=$${i++}`); vals.push(fields.status); }
      if (fields.settings != null) { sets.push(`settings=$${i++}`); vals.push(JSON.stringify(fields.settings)); }
      if ("geminiKey" in fields) { sets.push(`gemini_key=$${i++}`); vals.push(encryptSecret(fields.geminiKey)); }
      if ("elevenKey" in fields) { sets.push(`eleven_key=$${i++}`); vals.push(encryptSecret(fields.elevenKey)); }
      if (!sets.length) return store.getTenant(id);
      vals.push(id);
      await q(`UPDATE tenants SET ${sets.join(",")} WHERE id=$${i}`, vals);
      return store.getTenant(id);
    },

    // ---- users ----
    async createUser({ id = rid(), tenantId, email, password, role = "user", credits = 0 }) {
      const { salt, hash } = hashPw(password);
      await q("INSERT INTO users (id,tenant_id,email,password_hash,salt,role,credits,credits_month,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, tenantId, email.toLowerCase().trim(), hash, salt, role, Math.max(0, Math.round(credits)), ym(), Date.now()]);
      return store.getUserById(id);
    },
    async getUserById(id) { const r = await q("SELECT * FROM users WHERE id=$1", [id]); return r.rows[0] || null; },
    async getUserByEmail(email) { const r = await q("SELECT * FROM users WHERE email=$1", [(email || "").toLowerCase().trim()]); return r.rows[0] || null; },
    async listUsersByTenant(tenantId) { const r = await q("SELECT * FROM users WHERE tenant_id=$1 ORDER BY created_at ASC", [tenantId]); return r.rows; },
    async countUsers() { const r = await q("SELECT COUNT(*)::int AS c FROM users", []); return r.rows[0].c; },
    async setPassword(userId, password) {
      const { salt, hash } = hashPw(password);
      await q("UPDATE users SET password_hash=$1, salt=$2 WHERE id=$3", [hash, salt, userId]);
      await store.deleteUserSessions(userId);
    },
    async setCredits(userId, { set, add }) {
      if (Number.isFinite(+set)) await q("UPDATE users SET credits=$1 WHERE id=$2", [Math.max(0, Math.round(+set)), userId]);
      if (Number.isFinite(+add)) await q("UPDATE users SET credits=GREATEST(0, credits + $1::bigint) WHERE id=$2", [Math.round(+add), userId]);
      return store.getUserById(userId);
    },
    async deleteUser(userId) {
      await q("DELETE FROM sessions WHERE user_id=$1", [userId]);
      await q("DELETE FROM feed WHERE user_id=$1", [userId]);
      await q("DELETE FROM users WHERE id=$1", [userId]);
    },
    async ensureMonthly(user, startCredits) {
      const m = ym();
      if (user.credits_month !== m) {
        await q("UPDATE users SET credits=$1, credits_month=$2 WHERE id=$3", [startCredits, m, user.id]);
        user.credits = startCredits; user.credits_month = m;
      }
      return user;
    },

    // ---- atomic credit ledger (single SQL statement = safe under concurrency) ----
    async reserve(userId, amt) {
      const r = await q("UPDATE users SET credits = credits - $1::bigint WHERE id=$2 AND credits >= $3::bigint RETURNING credits", [amt, userId, amt]);
      return r.rowCount ? Number(r.rows[0].credits) : null; // null => insufficient
    },
    async refund(userId, amt) {
      const r = await q("UPDATE users SET credits = credits + $1::bigint WHERE id=$2 RETURNING credits", [amt, userId]);
      return r.rowCount ? Number(r.rows[0].credits) : null;
    },

    // ---- usage (per user / month) ----
    async recordUsage(userId, tenantId, kind, n, credits, usd) {
      const m = ym();
      await q(
        `INSERT INTO usage_stats (user_id,tenant_id,month,images,videos,vo,music,credits,usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id, month) DO UPDATE SET
           images=usage_stats.images+EXCLUDED.images, videos=usage_stats.videos+EXCLUDED.videos,
           vo=usage_stats.vo+EXCLUDED.vo, music=usage_stats.music+EXCLUDED.music,
           credits=usage_stats.credits+EXCLUDED.credits, usd=usage_stats.usd+EXCLUDED.usd`,
        [userId, tenantId, m, kind === "images" ? n : 0, kind === "videos" ? n : 0, kind === "vo" ? n : 0, kind === "music" ? n : 0, credits || 0, usd || 0]);
    },
    async usageForUser(userId, month = ym()) {
      const r = await q("SELECT images,videos,vo,music,credits,usd FROM usage_stats WHERE user_id=$1 AND month=$2", [userId, month]);
      return r.rows[0] || { images: 0, videos: 0, vo: 0, music: 0, credits: 0, usd: 0 };
    },
    async usageForTenant(tenantId, month = ym()) {
      const r = await q("SELECT COALESCE(SUM(images),0)::int AS images, COALESCE(SUM(videos),0)::int AS videos, COALESCE(SUM(vo),0)::int AS vo, COALESCE(SUM(music),0)::int AS music, COALESCE(SUM(credits),0)::bigint AS credits, COALESCE(SUM(usd),0) AS usd FROM usage_stats WHERE tenant_id=$1 AND month=$2", [tenantId, month]);
      const x = r.rows[0]; return { images: Number(x.images), videos: Number(x.videos), vo: Number(x.vo), music: Number(x.music), credits: Number(x.credits), usd: Number(x.usd) };
    },

    // ---- sessions ----
    async createSession(token, userId, expires) { await q("INSERT INTO sessions (token,user_id,expires) VALUES ($1,$2,$3)", [token, userId, expires]); },
    async getSession(token) { const r = await q("SELECT * FROM sessions WHERE token=$1", [token]); return r.rows[0] || null; },
    async deleteSession(token) { await q("DELETE FROM sessions WHERE token=$1", [token]); },
    async deleteUserSessions(userId) { await q("DELETE FROM sessions WHERE user_id=$1", [userId]); },

    // ---- feed ----
    async addFeed(rec) {
      await q("INSERT INTO feed (id,tenant_id,user_id,data,created_at) VALUES ($1,$2,$3,$4,$5)",
        [rec.id, rec.tenantId, rec.userId, JSON.stringify(rec), rec.createdAt || Date.now()]);
    },
    async getFeed(id) { const r = await q("SELECT data FROM feed WHERE id=$1", [id]); return r.rows[0] ? JSON.parse(r.rows[0].data) : null; },
    async updateFeed(rec) { await q("UPDATE feed SET data=$1 WHERE id=$2", [JSON.stringify(rec), rec.id]); },
    async listFeedByUser(userId) { const r = await q("SELECT data FROM feed WHERE user_id=$1 ORDER BY created_at DESC", [userId]); return r.rows.map((x) => JSON.parse(x.data)); },
    async deleteFeed(id) { await q("DELETE FROM feed WHERE id=$1", [id]); },
    async expiredFeed(tenantId, cutoff) { const r = await q("SELECT data FROM feed WHERE tenant_id=$1 AND created_at < $2", [tenantId, cutoff]); return r.rows.map((x) => JSON.parse(x.data)); },

    // ---- media ----
    async addMedia(file, tenantId, userId) { await q("INSERT INTO media (file,tenant_id,user_id,created_at) VALUES ($1,$2,$3,$4)", [file, tenantId, userId, Date.now()]); },
    async getMedia(file) { const r = await q("SELECT * FROM media WHERE file=$1", [file]); return r.rows[0] || null; },
    async deleteMedia(file) { await q("DELETE FROM media WHERE file=$1", [file]); },

    // ---- voice adds (per tenant, LRU) ----
    async getVoiceAdd(tenantId, k) { const r = await q("SELECT * FROM voice_adds WHERE tenant_id=$1 AND k=$2", [tenantId, k]); return r.rows[0] || null; },
    async setVoiceAdd(tenantId, k, voiceId) {
      await q(`INSERT INTO voice_adds (tenant_id,k,voice_id,last_used) VALUES ($1,$2,$3,$4)
               ON CONFLICT (tenant_id,k) DO UPDATE SET voice_id=EXCLUDED.voice_id, last_used=EXCLUDED.last_used`,
        [tenantId, k, voiceId, Date.now()]);
    },
    async touchVoiceAdd(tenantId, k) { await q("UPDATE voice_adds SET last_used=$1 WHERE tenant_id=$2 AND k=$3", [Date.now(), tenantId, k]); },
    async countVoiceAdds(tenantId) { const r = await q("SELECT COUNT(*)::int AS c FROM voice_adds WHERE tenant_id=$1", [tenantId]); return r.rows[0].c; },
    async lruVoiceAdd(tenantId) { const r = await q("SELECT * FROM voice_adds WHERE tenant_id=$1 ORDER BY last_used ASC LIMIT 1", [tenantId]); return r.rows[0] || null; },
    async deleteVoiceAdd(tenantId, k) { await q("DELETE FROM voice_adds WHERE tenant_id=$1 AND k=$2", [tenantId, k]); },
  };
  return store;
}

function hydrateTenant(row) {
  let settings = {};
  try { settings = JSON.parse(row.settings || "{}"); } catch {}
  return {
    id: row.id, name: row.name, status: row.status, settings,
    geminiKey: decryptSecret(row.gemini_key), elevenKey: decryptSecret(row.eleven_key),
    hasGeminiKey: !!row.gemini_key, hasElevenKey: !!row.eleven_key, createdAt: Number(row.created_at),
  };
}

// One-time migration from the legacy single-tenant db.json file.
export async function migrateFromJson(store, jsonPath, { defaultSettings, envGeminiKey, envElevenKey }) {
  const existing = await store.listTenants();
  if (existing.length) return false; // already migrated / fresh DB managed elsewhere
  if (!fs.existsSync(jsonPath)) return false;
  let db; try { db = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { return false; }
  if (!db || !db.users || !Object.keys(db.users).length) return false;
  const tenant = await store.createTenant({ name: "Default", settings: { ...defaultSettings, ...(db.settings || {}) }, geminiKey: envGeminiKey || null, elevenKey: envElevenKey || null });
  for (const u of Object.values(db.users)) {
    await store.pool.query("INSERT INTO users (id,tenant_id,email,password_hash,salt,role,credits,credits_month,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
      [u.id, tenant.id, u.email, u.passwordHash, u.salt, u.role === "admin" ? "admin" : "user", Math.max(0, Math.round(u.credits || 0)), u.creditsMonth || ym(), u.createdAt || Date.now()]);
  }
  for (const f of Object.values(db.feed || {})) {
    f.tenantId = tenant.id;
    await store.pool.query("INSERT INTO feed (id,tenant_id,user_id,data,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [f.id, tenant.id, f.userId, JSON.stringify(f), f.createdAt || Date.now()]);
  }
  for (const [file, userId] of Object.entries(db.media || {})) {
    await store.pool.query("INSERT INTO media (file,tenant_id,user_id,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (file) DO NOTHING", [file, tenant.id, userId, Date.now()]);
  }
  for (const [k, v] of Object.entries(db.voiceAdds || {})) {
    const vid = typeof v === "string" ? v : (v && v.id);
    if (vid) await store.setVoiceAdd(tenant.id, k, vid);
  }
  return tenant;
}
