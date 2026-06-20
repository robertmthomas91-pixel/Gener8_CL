// GENER8 — backend
// Multi-user app: auth + admin, credit ledger, persistent feed, and proxying to
// Google's Gemini models (Nano Banana Pro images + Veo 3.1 Fast video).
//
// All persistent data lives under DATA_DIR (point this at a Railway VOLUME so it
// survives redeploys), as a JSON database plus saved media files.
//
// The Gemini API key lives ONLY on the server and is never sent to the browser.

import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const DB_FILE = path.join(DATA_DIR, "db.json");

const START_CREDITS = 20000;
const IMAGE_COST = 2;   // credits per generated image
const VIDEO_COST = 10;  // credits per generated video

const IMAGE_MODEL = "gemini-3-pro-image-preview";   // Nano Banana Pro
const VIDEO_MODEL = "veo-3.1-fast-generate-preview"; // Veo 3.1 Fast
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

if (!API_KEY) {
  console.warn("\n⚠  GEMINI_API_KEY is not set — the app and accounts work, but generation calls return an error until you set it.\n");
}

// ---------------------------------------------------------------------------
// Tiny JSON datastore (fine for a single Railway instance with a volume)
// ---------------------------------------------------------------------------
fs.mkdirSync(MEDIA_DIR, { recursive: true });
let db = loadDb();
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { users: {}, sessions: {}, feed: {}, media: {}, meta: {} }; }
}
function saveDb() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function rid(n = 12) { return crypto.randomBytes(n).toString("hex"); }
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPw(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pw), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch { return false; }
}
function ym(d = new Date()) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

// ---- seed the admin account on first run -------------------------------------
(function seedAdmin() {
  if (Object.keys(db.users).length) return;
  const email = (process.env.ADMIN_EMAIL || "admin@gener8.app").toLowerCase().trim();
  let pw = process.env.ADMIN_PASSWORD, generated = false;
  if (!pw) { pw = rid(8); generated = true; }
  const id = rid();
  const { salt, hash } = hashPw(pw);
  db.users[id] = { id, email, passwordHash: hash, salt, role: "admin", credits: START_CREDITS, creditsMonth: ym(), createdAt: Date.now() };
  saveDb();
  console.log("\n==================== GENER8 admin account ====================");
  console.log("  email:    " + email);
  console.log(generated ? "  password: " + pw + "    (set ADMIN_PASSWORD to choose your own)" : "  password: (from your ADMIN_PASSWORD env var)");
  console.log("  Sign in with these, then add users from the Admin panel.");
  console.log("==============================================================\n");
})();

// On startup, any video records left mid-generation can't resume (their Google
// operation handles are in memory only) — mark them so the client refunds/cleans.
for (const f of Object.values(db.feed)) {
  if (f.type === "video" && f.status === "generating") {
    (f.slots || []).forEach((s) => { if (s.status === "generating") { s.status = "error"; s.error = "Interrupted by a server restart."; } });
    f.status = (f.slots || []).every((s) => s.status === "error") ? "error" : "done";
  }
}
saveDb();

// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "30mb" }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, userId) {
  const token = rid(24);
  db.sessions[token] = { userId, expires: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  saveDb();
  res.setHeader("Set-Cookie", `g8session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}
function clearSession(req, res) {
  const c = parseCookies(req);
  if (c.g8session) { delete db.sessions[c.g8session]; saveDb(); }
  res.setHeader("Set-Cookie", "g8session=; HttpOnly; Path=/; Max-Age=0");
}
function ensureMonthly(u) {
  const m = ym();
  if (u.creditsMonth !== m) { u.credits = START_CREDITS; u.creditsMonth = m; saveDb(); }
}
function currentUser(req) {
  const c = parseCookies(req);
  const s = c.g8session && db.sessions[c.g8session];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users[s.userId];
  if (!u) return null;
  ensureMonthly(u);
  return u;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Please sign in." });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Please sign in." });
  if (u.role !== "admin") return res.status(403).json({ error: "Admins only." });
  req.user = u; next();
}
function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, credits: u.credits, creditsMonth: u.creditsMonth, createdAt: u.createdAt };
}
function charge(u, amt) { u.credits = Math.max(0, u.credits - amt); saveDb(); }
function refund(u, amt) { u.credits += amt; saveDb(); }

// ---- media -----------------------------------------------------------------
function saveMedia(buf, ext, userId) {
  const fn = rid(16) + "." + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, fn), buf);
  db.media[fn] = userId;
  return "/media/" + fn;
}
function delMediaUrl(url) {
  if (!url || typeof url !== "string" || !url.startsWith("/media/")) return;
  const fn = url.slice(7);
  try { fs.unlinkSync(path.join(MEDIA_DIR, fn)); } catch {}
  delete db.media[fn];
}
function toImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { imageBytes: m[2], mimeType: m[1] };
}
function toInlineImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}
function clientRecord(r) {
  return {
    id: r.id, type: r.type, genMode: r.genMode, prompt: r.prompt, aspect: r.aspect,
    count: r.count, duration: r.duration, resolution: r.resolution,
    items: r.items, upscaled: r.upscaled, status: r.status, createdAt: r.createdAt,
    slots: r.slots ? r.slots.map((s) => ({ status: s.status, error: s.error })) : undefined,
  };
}

// ---- auth ------------------------------------------------------------------
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = Object.values(db.users).find((x) => x.email === (email || "").toLowerCase().trim());
  if (!u || !verifyPw(password || "", u.salt, u.passwordHash)) return res.status(401).json({ error: "Wrong email or password." });
  ensureMonthly(u);
  setSession(res, u.id);
  res.json({ user: publicUser(u) });
});
app.post("/api/logout", (req, res) => { clearSession(req, res); res.json({ ok: true }); });
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user), keyConfigured: !!ai }));
app.get("/api/health", (_q, res) => res.json({ ok: true, keyConfigured: !!ai }));

// ---- admin: user management ------------------------------------------------
app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json({ users: Object.values(db.users).map(publicUser).sort((a, b) => a.createdAt - b.createdAt) });
});
app.post("/api/admin/users", requireAdmin, (req, res) => {
  let { email, password, credits } = req.body || {};
  email = (email || "").toLowerCase().trim();
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (Object.values(db.users).some((u) => u.email === email)) return res.status(409).json({ error: "That email already exists." });
  const id = rid();
  const { salt, hash } = hashPw(password);
  db.users[id] = { id, email, passwordHash: hash, salt, role: "user", credits: Number.isFinite(+credits) ? Math.max(0, Math.round(+credits)) : START_CREDITS, creditsMonth: ym(), createdAt: Date.now() };
  saveDb();
  res.json({ user: publicUser(db.users[id]) });
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: "No such user." });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't delete your own admin account." });
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
  for (const [fid, f] of Object.entries(db.feed)) if (f.userId === u.id) { (f.items || []).forEach(delMediaUrl); delete db.feed[fid]; }
  delete db.users[u.id];
  saveDb();
  res.json({ ok: true });
});
app.post("/api/admin/users/:id/credits", requireAdmin, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: "No such user." });
  const { set, add } = req.body || {};
  if (Number.isFinite(+set)) u.credits = Math.max(0, Math.round(+set));
  if (Number.isFinite(+add)) u.credits = Math.max(0, u.credits + Math.round(+add));
  saveDb();
  res.json({ user: publicUser(u) });
});

// ---- media serving (owner or admin only) -----------------------------------
app.get("/media/:file", requireAuth, (req, res) => {
  const fn = path.basename(req.params.file);
  const owner = db.media[fn];
  if (!owner) return res.status(404).end();
  if (owner !== req.user.id && req.user.role !== "admin") return res.status(403).end();
  const fp = path.join(MEDIA_DIR, fn);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// ---- feed ------------------------------------------------------------------
app.get("/api/feed", requireAuth, (req, res) => {
  const feed = Object.values(db.feed).filter((f) => f.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(clientRecord);
  res.json({ feed, user: publicUser(req.user) });
});
app.delete("/api/feed/:id", requireAuth, (req, res) => {
  const r = db.feed[req.params.id];
  if (!r || r.userId !== req.user.id) return res.status(404).json({ error: "No such item." });
  (r.items || []).forEach(delMediaUrl);
  delete db.feed[req.params.id];
  saveDb();
  res.json({ ok: true });
});

// ---- IMAGES — Nano Banana Pro ----------------------------------------------
app.post("/api/generate-image", requireAuth, async (req, res) => {
  if (!ai) return res.status(503).json({ error: "Server has no GEMINI_API_KEY configured." });
  const u = req.user;
  try {
    const { prompt, count = 1, aspectRatio = "1:1", references = [] } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });
    const n = Math.max(1, Math.min(Number(count) || 1, 4));
    if (u.credits < IMAGE_COST * n) return res.status(402).json({ error: `Not enough credits — this needs ${IMAGE_COST * n}, you have ${u.credits}.` });

    const refParts = (references || []).map(toInlineImage).filter(Boolean).slice(0, 5);
    const contents = refParts.length ? [{ role: "user", parts: [{ text: prompt }, ...refParts] }] : prompt;
    const jobs = Array.from({ length: n }, () => ai.models.generateContent({ model: IMAGE_MODEL, contents, config: { imageConfig: { aspectRatio } } }));
    const results = await Promise.all(jobs);
    const items = [];
    for (const r of results) {
      const parts = r?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          const ext = (p.inlineData.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
          items.push(saveMedia(Buffer.from(p.inlineData.data, "base64"), ext, u.id));
        }
      }
    }
    if (!items.length) return res.status(502).json({ error: "The model returned no image (it may have been safety-filtered). Try a different prompt." });
    charge(u, IMAGE_COST * items.length);
    const r = { id: rid(), userId: u.id, type: "image", genMode: null, prompt, aspect: aspectRatio, count: items.length, items, upscaled: items.map(() => false), status: "done", createdAt: Date.now() };
    db.feed[r.id] = r; saveDb();
    res.json({ record: clientRecord(r), credits: u.credits });
  } catch (err) {
    console.error("generate-image:", err);
    res.status(500).json({ error: err?.message || "Image generation failed." });
  }
});

// ---- UPSCALE IMAGE to 4K ---------------------------------------------------
app.post("/api/upscale-image", requireAuth, async (req, res) => {
  if (!ai) return res.status(503).json({ error: "Server has no GEMINI_API_KEY configured." });
  const u = req.user;
  const { recordId, idx } = req.body || {};
  const r = db.feed[recordId];
  if (!r || r.userId !== u.id) return res.status(404).json({ error: "No such item." });
  const i = Number(idx);
  const url = r.items && r.items[i];
  if (!url || !url.startsWith("/media/")) return res.status(400).json({ error: "Nothing to upscale." });
  if (u.credits < IMAGE_COST) return res.status(402).json({ error: `Not enough credits — upscaling needs ${IMAGE_COST}.` });
  try {
    const buf = fs.readFileSync(path.join(MEDIA_DIR, url.slice(7)));
    const img = { inlineData: { mimeType: "image/png", data: buf.toString("base64") } };
    const result = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: "Upscale this image to 4K resolution. Preserve the exact composition, subject, colours and content; enhance sharpness and fine detail only. Do not add, remove, or restyle anything." }, img] }],
      config: { imageConfig: { aspectRatio: r.aspect || "1:1", imageSize: "4K" } },
    });
    const parts = result?.candidates?.[0]?.content?.parts || [];
    let newUrl = null;
    for (const p of parts) {
      if (p.inlineData?.data) { newUrl = saveMedia(Buffer.from(p.inlineData.data, "base64"), (p.inlineData.mimeType || "image/png").split("/")[1].replace("jpeg", "jpg"), u.id); break; }
    }
    if (!newUrl) return res.status(502).json({ error: "Upscale returned no image." });
    delMediaUrl(r.items[i]);
    r.items[i] = newUrl;
    r.upscaled = r.upscaled || [];
    r.upscaled[i] = true;
    charge(u, IMAGE_COST);
    saveDb();
    res.json({ url: newUrl, credits: u.credits });
  } catch (err) {
    console.error("upscale-image:", err);
    res.status(500).json({ error: err?.message || "Image upscale failed." });
  }
});

// ---- VIDEO — Veo 3.1 Fast (grouped record, up to 4 clips) ------------------
const videoOps = new Map(); // jobKey -> { op }
app.post("/api/generate-video", requireAuth, async (req, res) => {
  if (!ai) return res.status(503).json({ error: "Server has no GEMINI_API_KEY configured." });
  const u = req.user;
  try {
    const { mode = "video", prompt, aspectRatio = "16:9", duration = 8, negativePrompt = "", resolution = "1080p", frames = [], references = [], count = 1 } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "A prompt is required." });
    const n = Math.max(1, Math.min(Number(count) || 1, 4));
    if (u.credits < VIDEO_COST * n) return res.status(402).json({ error: `Not enough credits — this needs ${VIDEO_COST * n}, you have ${u.credits}.` });

    const config = { aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9", resolution, durationSeconds: Math.max(4, Math.min(Number(duration) || 8, 8)) };
    if (negativePrompt && negativePrompt.trim()) config.negativePrompt = negativePrompt.trim();
    const params = { model: VIDEO_MODEL, prompt };
    if (mode === "frames") {
      const first = toImage(frames[0]);
      if (!first) return res.status(400).json({ error: "Image → Video needs an input image." });
      params.image = first;
      const last = toImage(frames[1]);
      if (last) config.lastFrame = last;
      config.personGeneration = "allow_adult";
    } else if (mode === "ingredients") {
      const refs = (references || []).map(toImage).filter(Boolean).slice(0, 3);
      if (!refs.length) return res.status(400).json({ error: "Ingredients needs at least one reference image." });
      config.referenceImages = refs.map((im) => ({ image: im, referenceType: "asset" }));
      config.durationSeconds = 8;
      config.personGeneration = "allow_adult";
    }
    params.config = config;

    charge(u, VIDEO_COST * n); // reserve up-front; refunded per failed clip
    const r = { id: rid(), userId: u.id, type: "video", genMode: mode, prompt, aspect: config.aspectRatio, count: n, duration: config.durationSeconds, resolution, items: new Array(n).fill(null), slots: [], status: "generating", createdAt: Date.now() };
    for (let k = 0; k < n; k++) r.slots.push({ status: "generating", error: null, jobKey: null });
    db.feed[r.id] = r; saveDb();

    for (let k = 0; k < n; k++) {
      (async (slot) => {
        try {
          const op = await ai.models.generateVideos(params);
          const key = rid();
          videoOps.set(key, { op });
          slot.jobKey = key;
          saveDb();
        } catch (err) {
          slot.status = "error"; slot.error = err?.message || "Failed to start.";
          refund(u, VIDEO_COST);
          if (r.slots.every((s) => s.status !== "generating")) r.status = r.slots.every((s) => s.status === "error") ? "error" : "done";
          saveDb();
        }
      })(r.slots[k]);
    }
    res.json({ record: clientRecord(r), credits: u.credits });
  } catch (err) {
    console.error("generate-video:", err);
    res.status(500).json({ error: err?.message || "Video generation failed to start." });
  }
});

app.get("/api/video-status", requireAuth, async (req, res) => {
  const u = req.user;
  const r = db.feed[req.query.recordId];
  if (!r || r.userId !== u.id) return res.status(404).json({ error: "No such record." });
  if (r.type !== "video") return res.status(400).json({ error: "Not a video record." });
  for (let i = 0; i < r.slots.length; i++) {
    const slot = r.slots[i];
    if (slot.status !== "generating") continue;
    if (!slot.jobKey) continue; // not started yet
    const mem = videoOps.get(slot.jobKey);
    if (!mem) { slot.status = "error"; slot.error = "Interrupted by a server restart (credit refunded)."; refund(u, VIDEO_COST); saveDb(); continue; }
    try {
      const updated = await ai.operations.getVideosOperation({ operation: mem.op });
      mem.op = updated;
      if (updated?.done) {
        const uri = updated?.response?.generatedVideos?.[0]?.video?.uri;
        videoOps.delete(slot.jobKey);
        if (!uri) { slot.status = "error"; slot.error = "Blocked by safety filters (you were refunded)."; refund(u, VIDEO_COST); saveDb(); continue; }
        const up = await fetch(uri, { headers: { "x-goog-api-key": API_KEY }, redirect: "follow" });
        if (!up.ok || !up.body) { slot.status = "error"; slot.error = "Could not fetch the finished video."; refund(u, VIDEO_COST); saveDb(); continue; }
        const ab = await up.arrayBuffer();
        r.items[i] = saveMedia(Buffer.from(ab), "mp4", u.id);
        slot.status = "done";
        saveDb();
      }
    } catch (err) { /* transient — keep polling */ }
  }
  if (r.slots.every((s) => s.status !== "generating")) r.status = r.slots.every((s) => s.status === "error") ? "error" : "done";
  saveDb();
  res.json({ record: clientRecord(r), credits: u.credits });
});

// ---- static (login page + app) ---------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`GENER8 running on http://localhost:${PORT}  (key ${ai ? "configured ✓" : "MISSING ✗"}, data in ${DATA_DIR})`);
});
