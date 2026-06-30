// GENER8 — backend (multi-tenant, Postgres-backed)
//
// Each business is a "tenant" with its own users, credits, feed, settings and
// API keys. All persistence lives in Postgres via store.js. Per-tenant Gemini /
// ElevenLabs keys are stored encrypted (APP_SECRET) and never sent to browsers.
//
// Required env: DATABASE_URL (Railway Postgres). Recommended: APP_SECRET.
// Optional: SENTRY_DSN, SUPERADMIN_EMAIL/PASSWORD, ADMIN_EMAIL/PASSWORD,
// GEMINI_API_KEY/ELEVENLABS_API_KEY (seed the Default tenant), DATA_DIR, PORT.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import * as Sentry from "@sentry/node";
import pg from "pg";
import { makeStore, migrateFromJson, rid, ym, verifyPw } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const LEGACY_DB_FILE = path.join(DATA_DIR, "db.json"); // for one-time migration only
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  startCredits: 20000, imageCost: 2, imageProCost: 4, upscaleCost: 4,
  videoLite: 10, videoFast: 20, hdMultiplier: 1.5, voCost: 2, musicCost: 10, omniCost: 25,
  retentionDays: Number(process.env.RETENTION_DAYS) || 30,
};
const IMAGE_MODELS = { std: "gemini-2.5-flash-image", pro: "gemini-3-pro-image-preview" };
const IMAGE_PRO_MODEL = IMAGE_MODELS.pro;
const VIDEO_MODELS = { fast: "veo-3.1-fast-generate-preview", lite: "veo-3.1-lite-generate-preview" };
const OMNI_MODEL = "gemini-omni-flash-preview"; // Gemini Omni (Interactions API)
const OMNI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ELEVEN_TTS_MODEL = "eleven_multilingual_v2";
const ELEVEN_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const MAX_ADDED_VOICES = 10;

// ---- structured logging + Sentry -------------------------------------------
function log(level, msg, extra = {}) { try { console[level === "error" ? "error" : "log"](JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })); } catch { console.log(level, msg); } }
if (process.env.SENTRY_DSN) { Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 }); log("info", "Sentry enabled"); }
function captureError(err, context = {}) { try { if (process.env.SENTRY_DSN) Sentry.captureException(err, { extra: context }); } catch {} log("error", (err && err.message) || String(err), context); }
if (!process.env.APP_SECRET) log("warn", "APP_SECRET not set — per-tenant API keys are stored unencrypted. Set APP_SECRET in Railway → Variables.");

// ---- database ---------------------------------------------------------------
let pool, store;
async function openDb() {
  if (process.env.PGMEM) { // test-only in-memory Postgres
    const { newDb } = await import("pg-mem");
    pool = new (newDb().adapters.createPg().Pool)();
  } else {
    if (!process.env.DATABASE_URL) { log("error", "DATABASE_URL is not set — add a Railway Postgres database and set DATABASE_URL."); process.exit(1); }
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false }, max: 10 });
  }
  store = makeStore(pool);
  await store.initSchema();
}

function settingsOf(tenant) { return { ...DEFAULT_SETTINGS, ...(tenant && tenant.settings ? tenant.settings : {}) }; }
function pricingPublic(tenant) { const s = settingsOf(tenant); return { startCredits: s.startCredits, imageCost: s.imageCost, imageProCost: s.imageProCost, upscaleCost: s.upscaleCost, videoLite: s.videoLite, videoFast: s.videoFast, hdMultiplier: s.hdMultiplier, voCost: s.voCost, musicCost: s.musicCost, omniCost: s.omniCost, retentionDays: s.retentionDays }; }

// ---- per-tenant model clients ----------------------------------------------
const aiCache = new Map();
function tenantGenAI(tenant) {
  const key = tenant && tenant.geminiKey;
  if (!key) return null;
  if (!aiCache.has(key)) aiCache.set(key, new GoogleGenAI({ apiKey: key }));
  return aiCache.get(key);
}
function tenantElevenKey(tenant) { return (tenant && tenant.elevenKey) || null; }

// ---- seeding ----------------------------------------------------------------
async function seed() {
  await migrateFromJson(store, LEGACY_DB_FILE, { defaultSettings: DEFAULT_SETTINGS, envGeminiKey: process.env.GEMINI_API_KEY || null, envElevenKey: process.env.ELEVENLABS_API_KEY || null });
  // ensure a superadmin (manages tenants)
  const sres = await pool.query("SELECT id FROM users WHERE role='superadmin' LIMIT 1");
  if (!sres.rows.length) {
    const email = (process.env.SUPERADMIN_EMAIL || process.env.ADMIN_EMAIL || "super@gener8.app").toLowerCase().trim();
    let pw = process.env.SUPERADMIN_PASSWORD, gen = false;
    if (!pw) { pw = rid(8); gen = true; }
    const existing = await store.getUserByEmail(email);
    if (existing) { await pool.query("UPDATE users SET role='superadmin' WHERE id=$1", [existing.id]); }
    else { await store.createUser({ tenantId: null, email, password: pw, role: "superadmin", credits: 0 }); }
    log("info", "Superadmin ready", { email, password: gen ? pw : "(from SUPERADMIN_PASSWORD)" });
  }
  // fresh install with no tenants → create a Default tenant + its admin
  const tenants = await store.listTenants();
  if (!tenants.length) {
    const t = await store.createTenant({ name: "Default", settings: { ...DEFAULT_SETTINGS }, geminiKey: process.env.GEMINI_API_KEY || null, elevenKey: process.env.ELEVENLABS_API_KEY || null });
    const adminEmail = (process.env.ADMIN_EMAIL || "admin@gener8.app").toLowerCase().trim();
    let pw = process.env.ADMIN_PASSWORD, gen = false;
    if (!pw) { pw = rid(8); gen = true; }
    if (!(await store.getUserByEmail(adminEmail))) {
      await store.createUser({ tenantId: t.id, email: adminEmail, password: pw, role: "admin", credits: DEFAULT_SETTINGS.startCredits });
      log("info", "Default tenant admin ready", { email: adminEmail, password: gen ? pw : "(from ADMIN_PASSWORD)" });
    }
  }
}

// On startup, mark interrupted videos as errored and refund (operation handles are in memory only).
async function recoverInterruptedVideos() {
  const r = await pool.query("SELECT data FROM feed WHERE data LIKE '%\"status\":\"generating\"%'");
  for (const row of r.rows) {
    let f; try { f = JSON.parse(row.data); } catch { continue; }
    if (f.type !== "video" || f.status !== "generating") continue;
    let refundClips = 0;
    (f.slots || []).forEach((s) => { if (s.status === "generating") { s.status = "error"; s.error = "Interrupted by a server restart (credit refunded)."; refundClips++; } });
    f.status = (f.slots || []).every((s) => s.status === "error") ? "error" : "done";
    if (refundClips && f.userId && f.perClip) await store.refund(f.userId, refundClips * f.perClip);
    await store.updateFeed(f);
  }
}

// ---- local logical backups (snapshot all tables to JSON on the volume) ------
const BACKUP_KEEP = 28;
async function backupDb() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dump = {};
    for (const tbl of ["tenants", "users", "sessions", "feed", "media", "usage_stats", "voice_adds"]) {
      dump[tbl] = (await pool.query(`SELECT * FROM ${tbl}`)).rows;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(BACKUP_DIR, `dump-${ts}.json`), JSON.stringify(dump));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("dump-")).sort();
    while (files.length > BACKUP_KEEP) { try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch {} }
  } catch (e) { captureError(e, { where: "backupDb" }); }
}

async function pruneExpired() {
  try {
    for (const t of await store.listTenants()) {
      const cutoff = Date.now() - settingsOf(t).retentionDays * 86400000;
      const expired = await store.expiredFeed(t.id, cutoff);
      for (const f of expired) {
        (f.items || []).forEach(delMediaUrl);
        (f.inputs || []).forEach(delMediaUrl);
        await store.deleteFeed(f.id);
      }
    }
  } catch (e) { captureError(e, { where: "pruneExpired" }); }
}

// ---- media helpers ----------------------------------------------------------
async function saveMedia(buf, ext, tenantId, userId) {
  const fn = rid(16) + "." + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, fn), buf);
  await store.addMedia(fn, tenantId, userId);
  return "/media/" + fn;
}
function delMediaUrl(url) {
  if (!url || typeof url !== "string" || !url.startsWith("/media/")) return;
  const fn = url.slice(7);
  try { fs.unlinkSync(path.join(MEDIA_DIR, fn)); } catch {}
  store.deleteMedia(fn).catch(() => {});
}
async function saveInputUrl(d, tenantId, userId) { const im = toImage(d); if (!im) return null; return saveMedia(Buffer.from(im.imageBytes, "base64"), (im.mimeType.split("/")[1] || "png").replace("jpeg", "jpg").replace("+xml", ""), tenantId, userId); }
function toImage(dataUrl) { if (!dataUrl || typeof dataUrl !== "string") return null; const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/); return m ? { imageBytes: m[2], mimeType: m[1] } : null; }
function toInlineImage(dataUrl) { if (!dataUrl || typeof dataUrl !== "string") return null; const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/); return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null; }

function clientRecord(r) {
  return {
    id: r.id, type: r.type, subtype: r.subtype || null, voice: r.voice || null, voiceName: r.voiceName || null, genMode: r.genMode, imodel: r.imodel || null, omni: r.omni || false, prompt: r.prompt, neg: r.neg || "", model: r.model || "fast", aspect: r.aspect,
    count: r.count, duration: r.duration, resolution: r.resolution,
    items: r.items, inputs: r.inputs || [], upscaled: r.upscaled, status: r.status, createdAt: r.createdAt,
    slots: r.slots ? r.slots.map((s) => ({ status: s.status, error: s.error })) : undefined,
  };
}
function publicUser(u) { return { id: u.id, email: u.email, role: u.role, credits: Number(u.credits), creditsMonth: u.credits_month, createdAt: Number(u.created_at), tenantId: u.tenant_id }; }

// ===========================================================================
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30mb" }));

// ---- rate limiting ----------------------------------------------------------
const rlStore = new Map();
function clientIp(req) { return ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.ip || "ip"; }
function rateLimit({ max, windowMs, key }) {
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let e = rlStore.get(k);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; rlStore.set(k, e); }
    e.count++;
    if (e.count > max) { const sec = Math.ceil((e.reset - now) / 1000); res.setHeader("Retry-After", sec); return res.status(429).json({ error: `Too many requests — try again in ${sec}s.` }); }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rlStore) if (e.reset < now) rlStore.delete(k); }, 10 * 60 * 1000);
const loginLimit = rateLimit({ max: 12, windowMs: 15 * 60 * 1000, key: (req) => "login:" + clientIp(req) });
const genLimit = rateLimit({ max: 40, windowMs: 60 * 1000, key: (req) => "gen:" + ((req.cookies && req.cookies.g8session) || clientIp(req)) });
const loginFails = new Map();

// ---- cookies / auth ---------------------------------------------------------
function parseCookies(req) { const out = {}; (req.headers.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }
app.use((req, _res, next) => { req.cookies = parseCookies(req); next(); });
async function setSession(req, res, userId) {
  const token = rid(24);
  await store.createSession(token, userId, Date.now() + 1000 * 60 * 60 * 24 * 30);
  const secure = ((req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `g8session=${token}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${60 * 60 * 24 * 30}`);
}
async function currentUser(req) {
  const tok = req.cookies && req.cookies.g8session;
  if (!tok) return null;
  const s = await store.getSession(tok);
  if (!s || Number(s.expires) < Date.now()) return null;
  const u = await store.getUserById(s.user_id);
  if (!u) return null;
  u.tenant = u.tenant_id ? await store.getTenant(u.tenant_id) : null;
  if (u.tenant && u.tenant.status === "active") await store.ensureMonthly(u, settingsOf(u.tenant).startCredits);
  return u;
}
function asyncMw(fn) { return (req, res, next) => fn(req, res, next).catch((e) => { captureError(e, { route: req.path }); res.status(500).json({ error: "Server error." }); }); }
const requireAuth = asyncMw(async (req, res, next) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ error: "Please sign in." });
  if (u.tenant && u.tenant.status === "suspended") return res.status(403).json({ error: "This workspace is suspended. Contact your administrator." });
  req.user = u; req.tenant = u.tenant; next();
});
const requireAdmin = asyncMw(async (req, res, next) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ error: "Please sign in." });
  if (u.role !== "admin" && u.role !== "superadmin") return res.status(403).json({ error: "Admins only." });
  req.user = u; req.tenant = u.tenant; next();
});
const requireSuper = asyncMw(async (req, res, next) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ error: "Please sign in." });
  if (u.role !== "superadmin") return res.status(403).json({ error: "Superadmin only." });
  req.user = u; next();
});

// ---- auth endpoints ---------------------------------------------------------
app.post("/api/login", loginLimit, asyncMw(async (req, res) => {
  const email = ((req.body && req.body.email) || "").toLowerCase().trim();
  const password = (req.body && req.body.password) || "";
  const lock = loginFails.get(email);
  if (lock && lock.until > Date.now()) { const sec = Math.ceil((lock.until - Date.now()) / 1000); return res.status(429).json({ error: `Too many failed attempts — try again in ${sec}s.` }); }
  const u = await store.getUserByEmail(email);
  if (!u || !verifyPw(password, u.salt, u.password_hash)) {
    const f = loginFails.get(email) || { count: 0, until: 0 }; f.count++;
    if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
    loginFails.set(email, f);
    return res.status(401).json({ error: "Wrong email or password." });
  }
  loginFails.delete(email);
  const tenant = u.tenant_id ? await store.getTenant(u.tenant_id) : null;
  if (tenant && tenant.status === "suspended") return res.status(403).json({ error: "This workspace is suspended." });
  if (tenant) await store.ensureMonthly(u, settingsOf(tenant).startCredits);
  await setSession(req, res, u.id);
  res.json({ user: publicUser(u) });
}));
app.post("/api/logout", asyncMw(async (req, res) => { const tok = req.cookies && req.cookies.g8session; if (tok) await store.deleteSession(tok); res.setHeader("Set-Cookie", "g8session=; HttpOnly; Path=/; Max-Age=0"); res.json({ ok: true }); }));
app.get("/api/me", requireAuth, (req, res) => res.json({
  user: publicUser(req.user), role: req.user.role, isSuperadmin: req.user.role === "superadmin",
  keyConfigured: !!(req.tenant && req.tenant.geminiKey), elevenConfigured: !!(req.tenant && req.tenant.elevenKey),
  tenantName: req.tenant ? req.tenant.name : null, retentionDays: settingsOf(req.tenant).retentionDays, pricing: pricingPublic(req.tenant),
}));

function requireGemini(req, res) { const ai = tenantGenAI(req.tenant); if (!ai) { res.status(503).json({ error: "This workspace has no Gemini API key yet. An admin must add it." }); return null; } return ai; }
function requireEleven(req, res) { const k = tenantElevenKey(req.tenant); if (!k) { res.status(503).json({ error: "This workspace has no ElevenLabs API key yet. An admin must add it." }); return null; } return k; }

// ---- ElevenLabs voices ------------------------------------------------------
app.get("/api/voices", requireAuth, asyncMw(async (req, res) => {
  const ELEVEN_KEY = requireEleven(req, res); if (!ELEVEN_KEY) return;
  const q = (req.query.q || "").toString().trim();
  const out = []; let errDetail = null;
  if (!q) {
    try { const ar = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } }); if (ar.ok) { const ad = await ar.json(); (ad.voices || []).forEach((v) => { const acc = ((v.labels && v.labels.accent) || "").toString(); if (!/brit|english \(uk\)|en-?gb/i.test(acc)) return; out.push({ id: v.voice_id, name: v.name, preview: v.preview_url || null, ownerId: null, desc: "In your library" }); }); } } catch {}
  }
  try {
    const url = new URL("https://api.elevenlabs.io/v1/shared-voices");
    url.searchParams.set("page_size", "100"); url.searchParams.set("accent", "british");
    if (q) url.searchParams.set("search", q);
    const sr = await fetch(url, { headers: { "xi-api-key": ELEVEN_KEY } });
    if (sr.ok) { const sd = await sr.json(); (sd.voices || []).forEach((v) => { const acc = ((v.accent || "") + " " + (v.locale || "")).toLowerCase(); if (!/brit|en-?gb/.test(acc)) return; const bits = [v.gender, v.accent, v.age, v.use_case || v.descriptive].filter(Boolean); out.push({ id: v.voice_id, name: v.name, preview: v.preview_url || null, ownerId: v.public_owner_id || null, desc: bits.join(" · ") }); }); }
    else { const t = await sr.text(); errDetail = `ElevenLabs returned ${sr.status} (check the workspace ELEVENLABS key).` + (t ? " " + t.slice(0, 160) : ""); }
  } catch (err) { errDetail = err?.message || "Voice library request failed."; }
  const seen = new Set();
  const voices = out.filter((v) => v.id && !seen.has(v.id) && seen.add(v.id)).slice(0, 60);
  if (!voices.length && errDetail) return res.status(502).json({ error: errDetail });
  res.json({ voices });
}));

async function resolveVoice(tenant, voiceId, ownerId) {
  const ELEVEN_KEY = tenant.elevenKey;
  if (!ownerId) return voiceId;
  const k = ownerId + "/" + voiceId;
  const existing = await store.getVoiceAdd(tenant.id, k);
  if (existing) { await store.touchVoiceAdd(tenant.id, k); return existing.voice_id; }
  if ((await store.countVoiceAdds(tenant.id)) >= MAX_ADDED_VOICES) {
    const victim = await store.lruVoiceAdd(tenant.id);
    if (victim) { try { await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(victim.voice_id)}`, { method: "DELETE", headers: { "xi-api-key": ELEVEN_KEY } }); } catch {} await store.deleteVoiceAdd(tenant.id, victim.k); }
  }
  const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, { method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ new_name: "gener8-" + voiceId.slice(0, 8) }) });
  if (!r.ok) throw new Error("Could not add that library voice — the workspace ElevenLabs plan may be at its voice limit.");
  const d = await r.json(); const newId = d.voice_id || voiceId;
  await store.setVoiceAdd(tenant.id, k, newId);
  return newId;
}

// ---- VOICEOVER --------------------------------------------------------------
app.post("/api/generate-vo", genLimit, requireAuth, asyncMw(async (req, res) => {
  const ELEVEN_KEY = requireEleven(req, res); if (!ELEVEN_KEY) return;
  const u = req.user, t = req.tenant; const s = settingsOf(t); let reserved = 0;
  try {
    const { text, voiceId, ownerId, voiceName } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "Some text to speak is required." });
    if (text.length > 5000) return res.status(400).json({ error: "Text is too long (max 5000 characters)." });
    if ((await store.reserve(u.id, s.voCost)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${s.voCost}.` });
    reserved = s.voCost;
    let vid = (voiceId && /^[A-Za-z0-9_-]+$/.test(voiceId)) ? voiceId : ELEVEN_DEFAULT_VOICE;
    const owner = (ownerId && /^[A-Za-z0-9_-]+$/.test(ownerId)) ? ownerId : null;
    try { vid = await resolveVoice(t, vid, owner); } catch (e) { await store.refund(u.id, reserved); reserved = 0; return res.status(502).json({ error: e.message }); }
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, { method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" }, body: JSON.stringify({ text, model_id: ELEVEN_TTS_MODEL }) });
    if (!r.ok) { const tx = await r.text(); await store.refund(u.id, reserved); reserved = 0; return res.status(502).json({ error: "Voice generation failed: " + tx.slice(0, 200) }); }
    const url = await saveMedia(Buffer.from(await r.arrayBuffer()), "mp3", t.id, u.id);
    await store.recordUsage(u.id, t.id, "vo", 1, s.voCost, (text.length / 1000) * 0.30);
    const rec = { id: rid(), tenantId: t.id, userId: u.id, type: "audio", subtype: "vo", prompt: text, voice: vid, voiceName: voiceName || null, items: [url], inputs: [], status: "done", createdAt: Date.now() };
    await store.addFeed(rec);
    res.json({ record: clientRecord(rec), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (err) { if (reserved) await store.refund(u.id, reserved); captureError(err, { route: "generate-vo" }); res.status(500).json({ error: err?.message || "Voice generation failed." }); }
}));

// ---- MUSIC ------------------------------------------------------------------
app.post("/api/generate-music", genLimit, requireAuth, asyncMw(async (req, res) => {
  const ELEVEN_KEY = requireEleven(req, res); if (!ELEVEN_KEY) return;
  const u = req.user, t = req.tenant; const s = settingsOf(t); let reserved = 0;
  try {
    const { prompt, lengthMs } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A music prompt is required." });
    if ((await store.reserve(u.id, s.musicCost)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${s.musicCost}.` });
    reserved = s.musicCost;
    const len = Math.max(5000, Math.min(Number(lengthMs) || 30000, 120000));
    const r = await fetch("https://api.elevenlabs.io/v1/music", { method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" }, body: JSON.stringify({ prompt, music_length_ms: len }) });
    if (!r.ok) { const tx = await r.text(); await store.refund(u.id, reserved); reserved = 0; return res.status(502).json({ error: "Music generation failed: " + tx.slice(0, 200) }); }
    const url = await saveMedia(Buffer.from(await r.arrayBuffer()), "mp3", t.id, u.id);
    await store.recordUsage(u.id, t.id, "music", 1, s.musicCost, (len / 1000) * 0.08);
    const rec = { id: rid(), tenantId: t.id, userId: u.id, type: "audio", subtype: "music", prompt, duration: Math.round(len / 1000), items: [url], inputs: [], status: "done", createdAt: Date.now() };
    await store.addFeed(rec);
    res.json({ record: clientRecord(rec), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (err) { if (reserved) await store.refund(u.id, reserved); captureError(err, { route: "generate-music" }); res.status(500).json({ error: err?.message || "Music generation failed." }); }
}));

// ---- IMAGES -----------------------------------------------------------------
app.post("/api/generate-image", genLimit, requireAuth, asyncMw(async (req, res) => {
  const ai = requireGemini(req, res); if (!ai) return;
  const u = req.user, t = req.tenant; const s = settingsOf(t); let reserved = 0;
  try {
    const { prompt, count = 1, aspectRatio = "1:1", references = [], model = "std" } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });
    const n = Math.max(1, Math.min(Number(count) || 1, 4));
    const imodel = model === "pro" ? "pro" : "std";
    const perImage = imodel === "pro" ? s.imageProCost : s.imageCost;
    if ((await store.reserve(u.id, perImage * n)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${perImage * n}.` });
    reserved = perImage * n;
    const refData = (references || []).filter((d) => typeof d === "string" && d.startsWith("data:")).slice(0, 5);
    const refParts = refData.map(toInlineImage).filter(Boolean);
    const contents = refParts.length ? [{ role: "user", parts: [{ text: prompt }, ...refParts] }] : prompt;
    const jobs = Array.from({ length: n }, () => ai.models.generateContent({ model: IMAGE_MODELS[imodel], contents, config: { imageConfig: { aspectRatio } } }));
    const results = await Promise.all(jobs);
    const items = [];
    for (const r of results) { const parts = r?.candidates?.[0]?.content?.parts || []; for (const p of parts) if (p.inlineData?.data) { const ext = (p.inlineData.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg").replace("+xml", ""); items.push(await saveMedia(Buffer.from(p.inlineData.data, "base64"), ext, t.id, u.id)); } }
    if (!items.length) { await store.refund(u.id, reserved); reserved = 0; return res.status(502).json({ error: "The model returned no image (it may have been safety-filtered). Try a different prompt." }); }
    if (items.length < n) await store.refund(u.id, perImage * (n - items.length));
    reserved = perImage * items.length;
    await store.recordUsage(u.id, t.id, "images", items.length, reserved, (imodel === "pro" ? 0.13 : 0.04) * items.length);
    const inputs = []; for (const d of refData) { const iu = await saveInputUrl(d, t.id, u.id); if (iu) inputs.push(iu); }
    const r = { id: rid(), tenantId: t.id, userId: u.id, type: "image", genMode: null, imodel, prompt, aspect: aspectRatio, count: items.length, items, inputs, upscaled: items.map(() => false), status: "done", createdAt: Date.now() };
    await store.addFeed(r);
    res.json({ record: clientRecord(r), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (err) { if (reserved) await store.refund(u.id, reserved); captureError(err, { route: "generate-image" }); res.status(500).json({ error: err?.message || "Image generation failed." }); }
}));

app.post("/api/upscale-image", genLimit, requireAuth, asyncMw(async (req, res) => {
  const ai = requireGemini(req, res); if (!ai) return;
  const u = req.user, t = req.tenant; const s = settingsOf(t);
  const { recordId, idx } = req.body || {};
  const r = await store.getFeed(recordId);
  if (!r || r.userId !== u.id) return res.status(404).json({ error: "No such item." });
  const i = Number(idx); const url = r.items && r.items[i];
  if (!url || !url.startsWith("/media/")) return res.status(400).json({ error: "Nothing to upscale." });
  if ((await store.reserve(u.id, s.upscaleCost)) === null) return res.status(402).json({ error: `Not enough credits — upscaling needs ${s.upscaleCost}.` });
  let reserved = s.upscaleCost;
  try {
    const buf = fs.readFileSync(path.join(MEDIA_DIR, url.slice(7)));
    const img = { inlineData: { mimeType: "image/png", data: buf.toString("base64") } };
    const result = await ai.models.generateContent({ model: IMAGE_PRO_MODEL, contents: [{ role: "user", parts: [{ text: "Upscale this image to 4K resolution. Preserve the exact composition, subject, colours and content; enhance sharpness and fine detail only. Do not add, remove, or restyle anything." }, img] }], config: { imageConfig: { aspectRatio: r.aspect || "1:1", imageSize: "4K" } } });
    const parts = result?.candidates?.[0]?.content?.parts || []; let newUrl = null;
    for (const p of parts) if (p.inlineData?.data) { newUrl = await saveMedia(Buffer.from(p.inlineData.data, "base64"), (p.inlineData.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg"), t.id, u.id); break; }
    if (!newUrl) { await store.refund(u.id, reserved); reserved = 0; return res.status(502).json({ error: "Upscale returned no image." }); }
    delMediaUrl(r.items[i]); r.items[i] = newUrl; r.upscaled = r.upscaled || []; r.upscaled[i] = true;
    await store.recordUsage(u.id, t.id, "images", 0, s.upscaleCost, 0.24);
    await store.updateFeed(r);
    res.json({ url: newUrl, credits: Number((await store.getUserById(u.id)).credits) });
  } catch (err) { if (reserved) await store.refund(u.id, reserved); captureError(err, { route: "upscale-image" }); res.status(500).json({ error: err?.message || "Image upscale failed." }); }
}));

// ---- VIDEO ------------------------------------------------------------------
const videoOps = new Map();
app.post("/api/generate-video", genLimit, requireAuth, asyncMw(async (req, res) => {
  const ai = requireGemini(req, res); if (!ai) return;
  const u = req.user, t = req.tenant; const s = settingsOf(t); let reserved = 0;
  try {
    const { mode = "video", prompt, aspectRatio = "16:9", duration = 8, negativePrompt = "", resolution = "720p", frames = [], references = [], count = 1, model = "fast" } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });
    const n = Math.max(1, Math.min(Number(count) || 1, 4));
    const modelKey = model === "lite" ? "lite" : "fast";
    const base = modelKey === "lite" ? s.videoLite : s.videoFast;
    const perClip = Math.round(base * (resolution === "1080p" ? s.hdMultiplier : 1));
    const perClipUsd = (modelKey === "fast" ? 0.15 : (resolution === "1080p" ? 0.08 : 0.05)) * Math.max(4, Math.min(Number(duration) || 8, 8));
    const config = { aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9", resolution, durationSeconds: Math.max(4, Math.min(Number(duration) || 8, 8)) };
    if (negativePrompt && negativePrompt.trim()) config.negativePrompt = negativePrompt.trim();
    const params = { model: VIDEO_MODELS[modelKey], prompt };
    if (mode === "frames") {
      const first = toImage(frames[0]); if (!first) return res.status(400).json({ error: "Image → Video needs an input image." });
      params.image = first; if (modelKey !== "lite") { const last = toImage(frames[1]); if (last) config.lastFrame = last; }
      config.personGeneration = "allow_adult";
    } else if (mode === "ingredients") {
      const refs = (references || []).map(toImage).filter(Boolean).slice(0, 3); if (!refs.length) return res.status(400).json({ error: "Ingredients needs at least one reference image." });
      if (modelKey === "lite") params.image = refs[0]; else config.referenceImages = refs.map((im) => ({ image: im, referenceType: "asset" }));
      config.durationSeconds = 8; config.personGeneration = "allow_adult";
    }
    params.config = config;
    let inputUrls = [];
    if (mode === "frames") { for (const d of (frames || []).filter((d) => typeof d === "string" && d.startsWith("data:")).slice(0, 2)) { const iu = await saveInputUrl(d, t.id, u.id); if (iu) inputUrls.push(iu); } }
    else if (mode === "ingredients") { for (const d of (references || []).filter((d) => typeof d === "string" && d.startsWith("data:")).slice(0, 3)) { const iu = await saveInputUrl(d, t.id, u.id); if (iu) inputUrls.push(iu); } }
    if ((await store.reserve(u.id, perClip * n)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${perClip * n}.` });
    reserved = perClip * n;
    const r = { id: rid(), tenantId: t.id, userId: u.id, type: "video", genMode: mode, prompt, neg: (negativePrompt && negativePrompt.trim()) || "", aspect: config.aspectRatio, count: n, duration: config.durationSeconds, resolution, model: modelKey, perClip, perClipUsd, items: new Array(n).fill(null), inputs: inputUrls, slots: [], status: "generating", createdAt: Date.now() };
    for (let k = 0; k < n; k++) r.slots.push({ status: "generating", error: null, jobKey: null });
    await store.addFeed(r);
    for (let k = 0; k < n; k++) {
      (async (slot) => {
        try { const op = await ai.models.generateVideos(params); const key = rid(); videoOps.set(key, { op }); slot.jobKey = key; await store.updateFeed(r); }
        catch (err) { slot.status = "error"; slot.error = err?.message || "Failed to start."; await store.refund(u.id, perClip); if (r.slots.every((sl) => sl.status !== "generating")) r.status = r.slots.every((sl) => sl.status === "error") ? "error" : "done"; await store.updateFeed(r); }
      })(r.slots[k]);
    }
    res.json({ record: clientRecord(r), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (err) { if (reserved) await store.refund(u.id, reserved); captureError(err, { route: "generate-video" }); res.status(500).json({ error: err?.message || "Video generation failed to start." }); }
}));

app.get("/api/video-status", requireAuth, asyncMw(async (req, res) => {
  const u = req.user, t = req.tenant;
  const r = await store.getFeed(req.query.recordId);
  if (!r || r.userId !== u.id) return res.status(404).json({ error: "No such record." });
  if (r.type !== "video") return res.status(400).json({ error: "Not a video record." });
  const ai = tenantGenAI(t); const perClip = r.perClip || 10;
  await Promise.all(r.slots.map(async (slot, i) => {
    if (slot.status !== "generating" || !slot.jobKey) return;
    const mem = videoOps.get(slot.jobKey);
    if (!mem || !ai) { slot.status = "error"; slot.error = "Interrupted by a server restart (credit refunded)."; await store.refund(u.id, perClip); return; }
    try {
      const updated = await ai.operations.getVideosOperation({ operation: mem.op }); mem.op = updated;
      if (!updated?.done) return;
      const uri = updated?.response?.generatedVideos?.[0]?.video?.uri; videoOps.delete(slot.jobKey);
      if (!uri) { slot.status = "error"; slot.error = "Blocked by safety filters (you were refunded)."; await store.refund(u.id, perClip); return; }
      const up = await fetch(uri, { headers: { "x-goog-api-key": t.geminiKey }, redirect: "follow" });
      if (!up.ok || !up.body) { slot.status = "error"; slot.error = "Could not fetch the finished video."; await store.refund(u.id, perClip); return; }
      r.items[i] = await saveMedia(Buffer.from(await up.arrayBuffer()), "mp4", t.id, u.id);
      slot.status = "done";
      await store.recordUsage(u.id, t.id, "videos", 1, r.perClip || 0, r.perClipUsd || 0);
    } catch (err) { /* transient — keep polling */ }
  }));
  if (r.slots.every((sl) => sl.status !== "generating")) r.status = r.slots.every((sl) => sl.status === "error") ? "error" : "done";
  await store.updateFeed(r);
  res.json({ record: clientRecord(r), credits: Number((await store.getUserById(u.id)).credits) });
}));

// ---- GEMINI OMNI (Interactions API: text/image/reference -> video, + editing) ----
function omniVideoOut(resp) {
  const steps = resp?.steps || [];
  for (const st of steps) for (const cnt of (st.content || [])) if (cnt.type === "video") return { uri: cnt.uri || null, data: cnt.data || null };
  if (resp?.output_video) return { uri: resp.output_video.uri || null, data: resp.output_video.data || null };
  return { uri: null, data: null };
}
function omniFileId(uri) { const m = (uri || "").match(/files\/([^:?/]+)/); return m ? m[1] : null; }
async function omniCreate(key, body, timeoutMs = 100000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${OMNI_BASE}/interactions`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`Omni ${r.status}: ${(await r.text()).slice(0, 180)}`);
    return r.json();
  } catch (e) { if (e && e.name === "AbortError") throw new Error("Omni request timed out starting the job."); throw e; }
  finally { clearTimeout(to); }
}
async function omniFileState(key, id) { try { const r = await fetch(`${OMNI_BASE}/files/${id}`, { headers: { "x-goog-api-key": key } }); if (!r.ok) return null; const d = await r.json(); return (typeof d.state === "string" ? d.state : (d.state && d.state.name)) || null; } catch { return null; } }
async function omniDownload(key, id) { const r = await fetch(`${OMNI_BASE}/files/${id}:download?alt=media`, { headers: { "x-goog-api-key": key }, redirect: "follow" }); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()); }

app.post("/api/generate-omni", genLimit, requireAuth, asyncMw(async (req, res) => {
  const t = req.tenant, u = req.user; const s = settingsOf(t); let reserved = 0;
  if (!t || !t.geminiKey) return res.status(503).json({ error: "This workspace has no Gemini API key yet. An admin must add it." });
  try {
    const { mode = "video", prompt, aspectRatio = "16:9", references = [], frames = [], count = 1 } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });
    const n = Math.max(1, Math.min(Number(count) || 1, 4));
    const aspect = aspectRatio === "9:16" ? "9:16" : "16:9";
    // Build input + task BEFORE reserving (so validation failures don't charge).
    let input, task, inputUrls = [];
    if (mode === "frames") {
      const im = toImage(frames[0]); if (!im) return res.status(400).json({ error: "Image → Video needs an input image." });
      input = [{ type: "image", data: im.imageBytes, mime_type: im.mimeType }, { type: "text", text: prompt }]; task = "image_to_video";
      const iu = await saveInputUrl(frames[0], t.id, u.id); if (iu) inputUrls.push(iu);
    } else if (mode === "ingredients") {
      const refs = (references || []).map(toImage).filter(Boolean).slice(0, 3); if (!refs.length) return res.status(400).json({ error: "Ingredients needs at least one reference image." });
      input = [...refs.map((im) => ({ type: "image", data: im.imageBytes, mime_type: im.mimeType })), { type: "text", text: prompt }]; task = "reference_to_video";
      for (const d of (references || []).slice(0, 3)) { const iu = await saveInputUrl(d, t.id, u.id); if (iu) inputUrls.push(iu); }
    } else { input = prompt; task = "text_to_video"; }
    const per = s.omniCost;
    if ((await store.reserve(u.id, per * n)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${per * n}.` });
    reserved = per * n;
    const startOne = async () => {
      try {
        const resp = await omniCreate(t.geminiKey, { model: OMNI_MODEL, input, response_format: { type: "video", aspect_ratio: aspect, delivery: "uri" }, generation_config: { video_config: { task } } });
        const v = omniVideoOut(resp); const fid = omniFileId(v.uri);
        if (v.data && !fid) { const url = await saveMedia(Buffer.from(v.data, "base64"), "mp4", t.id, u.id); return { status: "done", url, interactionId: resp.id || null, error: null }; }
        if (fid) return { status: "generating", fileId: fid, interactionId: resp.id || null, error: null };
        await store.refund(u.id, per); return { status: "error", error: "Omni returned no video." };
      } catch (e) { captureError(e, { route: "generate-omni", model: OMNI_MODEL }); await store.refund(u.id, per); return { status: "error", error: e?.message || "Failed to start." }; }
    };
    const slots = await Promise.all(Array.from({ length: n }, startOne));
    const items = slots.map((sl) => sl.url || null);
    const allErr = slots.every((sl) => sl.status === "error");
    const anyGen = slots.some((sl) => sl.status === "generating");
    const rec = { id: rid(), tenantId: t.id, userId: u.id, type: "video", omni: true, genMode: mode, prompt, aspect, count: n, resolution: "auto", model: "omni", perClip: per, perClipUsd: 0.5, items, inputs: inputUrls, slots, status: allErr ? "error" : (anyGen ? "generating" : "done"), createdAt: Date.now() };
    await store.addFeed(rec);
    res.json({ record: clientRecord(rec), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (e) { if (reserved) await store.refund(u.id, reserved); captureError(e, { route: "generate-omni" }); res.status(500).json({ error: e?.message || "Omni generation failed." }); }
}));

app.get("/api/omni-status", requireAuth, asyncMw(async (req, res) => {
  const u = req.user, t = req.tenant;
  const r = await store.getFeed(req.query.recordId);
  if (!r || r.userId !== u.id) return res.status(404).json({ error: "No such record." });
  if (!r.omni) return res.status(400).json({ error: "Not an Omni record." });
  const key = t && t.geminiKey; const per = r.perClip || 25;
  await Promise.all((r.slots || []).map(async (slot, i) => {
    if (slot.status !== "generating" || !slot.fileId) return;
    if (!key) { slot.status = "error"; slot.error = "Workspace key missing (refunded)."; await store.refund(u.id, per); return; }
    const st = await omniFileState(key, slot.fileId);
    if (st === "FAILED") { slot.status = "error"; slot.error = "Generation failed (refunded)."; await store.refund(u.id, per); return; }
    if (st !== "ACTIVE") return;
    const buf = await omniDownload(key, slot.fileId);
    if (!buf) return; // try again next poll
    r.items[i] = await saveMedia(buf, "mp4", t.id, u.id);
    slot.status = "done";
    await store.recordUsage(u.id, t.id, "videos", 1, r.perClip || 0, r.perClipUsd || 0);
  }));
  if ((r.slots || []).every((sl) => sl.status !== "generating")) r.status = r.slots.every((sl) => sl.status === "error") ? "error" : "done";
  await store.updateFeed(r);
  res.json({ record: clientRecord(r), credits: Number((await store.getUserById(u.id)).credits) });
}));

app.post("/api/edit-omni", genLimit, requireAuth, asyncMw(async (req, res) => {
  const t = req.tenant, u = req.user; const s = settingsOf(t); let reserved = 0;
  if (!t || !t.geminiKey) return res.status(503).json({ error: "This workspace has no Gemini API key yet." });
  const { recordId, idx, prompt } = req.body || {};
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "An edit instruction is required." });
  const src = await store.getFeed(recordId);
  if (!src || src.userId !== u.id || !src.omni) return res.status(404).json({ error: "No such Omni clip." });
  const i = Number(idx) || 0; const slot = (src.slots || [])[i];
  const prevId = slot && slot.interactionId;
  if (!prevId) return res.status(400).json({ error: "This clip can't be edited." });
  if ((await store.reserve(u.id, s.omniCost)) === null) return res.status(402).json({ error: `Not enough credits — this needs ${s.omniCost}.` });
  reserved = s.omniCost;
  try {
    const resp = await omniCreate(t.geminiKey, { model: OMNI_MODEL, previous_interaction_id: prevId, input: prompt.trim(), response_format: { type: "video", aspect_ratio: src.aspect || "16:9", delivery: "uri" } });
    const v = omniVideoOut(resp); const fid = omniFileId(v.uri);
    let slots, items, status;
    if (v.data && !fid) { const url = await saveMedia(Buffer.from(v.data, "base64"), "mp4", t.id, u.id); slots = [{ status: "done", url, interactionId: resp.id || null, error: null }]; items = [url]; status = "done"; }
    else if (fid) { slots = [{ status: "generating", fileId: fid, interactionId: resp.id || null, error: null }]; items = [null]; status = "generating"; }
    else { await store.refund(u.id, reserved); return res.status(502).json({ error: "Omni returned no video." }); }
    const rec = { id: rid(), tenantId: t.id, userId: u.id, type: "video", omni: true, genMode: "edit", prompt: "Edit: " + prompt.trim(), aspect: src.aspect || "16:9", count: 1, resolution: "auto", model: "omni", perClip: s.omniCost, perClipUsd: 0.5, items, inputs: [], slots, status, createdAt: Date.now() };
    await store.addFeed(rec);
    res.json({ record: clientRecord(rec), credits: Number((await store.getUserById(u.id)).credits) });
  } catch (e) { if (reserved) await store.refund(u.id, reserved); captureError(e, { route: "edit-omni" }); res.status(500).json({ error: e?.message || "Omni edit failed." }); }
}));

// ---- media serving ----------------------------------------------------------
app.get("/media/:file", requireAuth, asyncMw(async (req, res) => {
  const fn = path.basename(req.params.file);
  const m = await store.getMedia(fn);
  if (!m) return res.status(404).end();
  const sameTenant = m.tenant_id === req.user.tenant_id;
  if (!(m.user_id === req.user.id || (req.user.role === "admin" && sameTenant) || req.user.role === "superadmin")) return res.status(403).end();
  const fp = path.join(MEDIA_DIR, fn);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
}));

// ---- feed -------------------------------------------------------------------
app.get("/api/feed", requireAuth, asyncMw(async (req, res) => {
  const feed = (await store.listFeedByUser(req.user.id)).map(clientRecord);
  res.json({ feed, user: publicUser(req.user), retentionDays: settingsOf(req.tenant).retentionDays, pricing: pricingPublic(req.tenant) });
}));
app.delete("/api/feed/:id", requireAuth, asyncMw(async (req, res) => {
  const r = await store.getFeed(req.params.id);
  if (!r || r.userId !== req.user.id) return res.status(404).json({ error: "No such item." });
  (r.items || []).forEach(delMediaUrl); (r.inputs || []).forEach(delMediaUrl);
  await store.deleteFeed(req.params.id);
  res.json({ ok: true });
}));

// ---- tenant admin (manages their own workspace) -----------------------------
app.get("/api/admin/users", requireAdmin, asyncMw(async (req, res) => {
  const tid = req.user.tenant_id; if (!tid) return res.json({ users: [] });
  const users = await store.listUsersByTenant(tid);
  const out = [];
  for (const u of users) out.push({ ...publicUser(u), usage: await store.usageForUser(u.id) });
  res.json({ users: out });
}));
app.post("/api/admin/users", requireAdmin, asyncMw(async (req, res) => {
  const tid = req.user.tenant_id; if (!tid) return res.status(400).json({ error: "Superadmin must act within a workspace." });
  let { email, password, credits } = req.body || {};
  email = (email || "").toLowerCase().trim();
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: "That email already exists." });
  const u = await store.createUser({ tenantId: tid, email, password, role: "user", credits: Number.isFinite(+credits) ? +credits : settingsOf(req.tenant).startCredits });
  res.json({ user: publicUser(u) });
}));
app.delete("/api/admin/users/:id", requireAdmin, asyncMw(async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target || target.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "No such user." });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  for (const f of await store.listFeedByUser(target.id)) { (f.items || []).forEach(delMediaUrl); (f.inputs || []).forEach(delMediaUrl); }
  await store.deleteUser(target.id);
  res.json({ ok: true });
}));
app.post("/api/admin/users/:id/credits", requireAdmin, asyncMw(async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target || target.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "No such user." });
  const u = await store.setCredits(target.id, req.body || {});
  res.json({ user: publicUser(u) });
}));
app.post("/api/admin/users/:id/password", requireAdmin, asyncMw(async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target || target.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "No such user." });
  const pw = (req.body && req.body.password) || "";
  if (String(pw).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  await store.setPassword(target.id, pw);
  res.json({ ok: true });
}));
app.get("/api/admin/settings", requireAdmin, asyncMw(async (req, res) => res.json({ settings: settingsOf(req.tenant) })));
app.post("/api/admin/settings", requireAdmin, asyncMw(async (req, res) => {
  const tid = req.user.tenant_id; if (!tid) return res.status(400).json({ error: "No workspace." });
  const allowed = ["startCredits", "imageCost", "imageProCost", "upscaleCost", "videoLite", "videoFast", "hdMultiplier", "voCost", "musicCost", "omniCost", "retentionDays"];
  const cur = settingsOf(req.tenant); const b = req.body || {};
  for (const k of allowed) { if (b[k] == null || !Number.isFinite(+b[k])) continue; let v = +b[k]; if (k !== "hdMultiplier") v = Math.round(v); cur[k] = Math.max(k === "hdMultiplier" ? 1 : 0, v); }
  const t = await store.updateTenant(tid, { settings: cur });
  res.json({ settings: settingsOf(t) });
}));
app.get("/api/admin/backup", requireAdmin, asyncMw(async (req, res) => {
  const tid = req.user.tenant_id;
  const dump = { tenant: req.tenant && req.tenant.name };
  dump.users = (await store.listUsersByTenant(tid)).map((u) => publicUser(u));
  const fr = await pool.query("SELECT data FROM feed WHERE tenant_id=$1", [tid]);
  dump.feed = fr.rows.map((x) => JSON.parse(x.data));
  res.setHeader("Content-Disposition", `attachment; filename="gener8-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(dump));
}));

// ---- superadmin: tenant management -----------------------------------------
async function tenantSummary(t) { return { id: t.id, name: t.name, status: t.status, hasGeminiKey: t.hasGeminiKey, hasElevenKey: t.hasElevenKey, createdAt: t.createdAt, users: (await store.listUsersByTenant(t.id)).length, usage: await store.usageForTenant(t.id) }; }
app.get("/api/super/tenants", requireSuper, asyncMw(async (req, res) => { const out = []; for (const t of await store.listTenants()) out.push(await tenantSummary(t)); res.json({ tenants: out }); }));
app.post("/api/super/tenants", requireSuper, asyncMw(async (req, res) => {
  const { name, adminEmail, adminPassword, geminiKey, elevenKey, startCredits } = req.body || {};
  if (!name || !adminEmail || !adminPassword) return res.status(400).json({ error: "Workspace name, admin email and admin password are required." });
  if (String(adminPassword).length < 6) return res.status(400).json({ error: "Admin password must be at least 6 characters." });
  if (await store.getUserByEmail(adminEmail)) return res.status(409).json({ error: "That admin email already exists." });
  const settings = { ...DEFAULT_SETTINGS }; if (Number.isFinite(+startCredits)) settings.startCredits = Math.max(0, Math.round(+startCredits));
  const t = await store.createTenant({ name, settings, geminiKey: geminiKey || null, elevenKey: elevenKey || null });
  await store.createUser({ tenantId: t.id, email: adminEmail, password: adminPassword, role: "admin", credits: settings.startCredits });
  res.json({ tenant: await tenantSummary(t) });
}));
app.post("/api/super/tenants/:id", requireSuper, asyncMw(async (req, res) => {
  const t = await store.getTenant(req.params.id); if (!t) return res.status(404).json({ error: "No such workspace." });
  const fields = {}; const b = req.body || {};
  if (b.name != null) fields.name = String(b.name);
  if (b.status === "active" || b.status === "suspended") fields.status = b.status;
  if ("geminiKey" in b) fields.geminiKey = b.geminiKey || null;   // admin pastes their own key
  if ("elevenKey" in b) fields.elevenKey = b.elevenKey || null;
  await store.updateTenant(t.id, fields);
  res.json({ tenant: await tenantSummary(await store.getTenant(t.id)) });
}));

// ---- health + static --------------------------------------------------------
app.get("/api/health", asyncMw(async (_q, res) => { let db = false; try { await pool.query("SELECT 1"); db = true; } catch {} res.json({ ok: db, db }); }));
app.use(express.static(path.join(__dirname, "public")));
if (process.env.SENTRY_DSN && Sentry.expressErrorHandler) app.use(Sentry.expressErrorHandler());

// ---- boot -------------------------------------------------------------------
(async () => {
  await openDb();
  await seed();
  await recoverInterruptedVideos();
  await pruneExpired();
  await backupDb();
  setInterval(pruneExpired, 6 * 60 * 60 * 1000);
  setInterval(backupDb, 6 * 60 * 60 * 1000);
  app.listen(PORT, () => log("info", `GENER8 running on :${PORT}`, { db: process.env.PGMEM ? "pg-mem" : "postgres" }));
})().catch((e) => { captureError(e, { where: "boot" }); process.exit(1); });

export { app };
