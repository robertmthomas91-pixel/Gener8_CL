# GENER8

A multi-user web app for generating images and video with Google's Gemini models:

- **Images** — Nano Banana Pro (`gemini-3-pro-image-preview`)
- **Video** — Veo 3.1 Fast (`veo-3.1-fast-generate-preview`)

The Gemini API key lives **only on the server** (as an environment variable) and is never exposed to the browser. The front-end talks only to this app's own `/api/*` endpoints, which add the key and forward to Google.

```
Browser (UI)  ──>  this server /api/*  ──>  Google Gemini API
                       ▲ GEMINI_API_KEY (env var)
```

---

## 1. Get a Gemini API key

1. Go to https://aistudio.google.com/apikey and create a key.
2. **Enable billing** on the Google Cloud project behind it — Nano Banana Pro and Veo 3.1 Fast are **paid preview** models and will not run on a free tier.

---

## 2. Deploy to Railway (recommended)

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects Node, runs `npm install`, and starts it with `npm start`.
4. **Attach a Volume** (service → **+ Volume**) and set its **mount path** to `/data`. This is what makes accounts, credits, the feed, and saved media survive redeploys.
5. Open the service's **Variables** tab and add:

   | Variable | Value |
   |---|---|
   | `GEMINI_API_KEY` | *your key from step 1* |
   | `ADMIN_EMAIL` | *the email for your first admin login* |
   | `ADMIN_PASSWORD` | *a strong password for that admin* |
   | `DATA_DIR` | `/data` *(the volume mount path)* |

   The key and passwords live only here — never in the code or git.
6. Railway sets `PORT` automatically. Deploy, open the generated URL, and sign in with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`. (If you didn't set `ADMIN_PASSWORD`, check the deploy logs for the generated one.)

> **A volume is required** for a single-instance service like this. Without it, Railway's filesystem is wiped on every redeploy and you'd lose users and the feed. Keep the service at **1 replica** (a volume can't be shared across replicas).

> Changing the key later: edit the `GEMINI_API_KEY` variable and redeploy. The top-right pill in the UI shows **API connected** when the server sees a key.

---

## 3. Run locally (optional)

```bash
cd reel-studio
npm install
cp .env.example .env        # then edit .env and paste your key
export GEMINI_API_KEY=...   # (or rely on the .env you just made)
npm start                   # http://localhost:3000
```

> Note: `.env` is git-ignored. The provided `server.js` reads `process.env.GEMINI_API_KEY` directly; if you want it to auto-load a `.env` file locally, run with `node --env-file=.env server.js` (Node 20+) or add the `dotenv` package.

---

## 4. How it works

- `POST /api/generate-image` `{ prompt, count, aspectRatio, references }` → runs up to 4 Nano Banana Pro calls, **saves** the images to `DATA_DIR`, charges credits, and returns a feed `record` (with `/media/...` URLs) + the new `credits` balance. `references` is up to 5 image data-URLs used as context.
- `POST /api/upscale-image` `{ recordId, idx }` → re-renders that feed item at **4K**, replaces it, charges 2 credits.
- `POST /api/generate-video` `{ mode, prompt, aspectRatio, duration, negativePrompt, resolution, frames, references, count }` → reserves `10 × count` credits and starts up to 4 Veo 3.1 Fast jobs grouped into one feed `record`; returns the record. `mode` is one of:
  - `video` — text → video.
  - `frames` — image → video: `frames[0]` is the input/first frame, optional `frames[1]` is the last frame. Sent as the `image` + `config.lastFrame`.
  - `ingredients` — up to 3 reference images that preserve a subject/character/product. Forces 8s.
- `GET /api/video-status?recordId=...` → polls all of a record's clips; finished clips are downloaded and saved to `DATA_DIR`; failed clips are refunded. Returns the updated `record` + `credits`.
- `GET /media/:file` → serves a saved image/video (owner or admin only).
- `GET /api/health` → `{ keyConfigured: true|false }`.
- **Auth:** `POST /api/login`, `POST /api/logout`, `GET /api/me`. **Admin:** `GET/POST /api/admin/users`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/credits`. **Feed:** `GET /api/feed`, `DELETE /api/feed/:id`. All generation/feed endpoints require a signed-in session and charge credits.

Video jobs are tracked in memory, which is fine for a single Railway instance. If you scale to multiple replicas, move that map to a shared store (e.g. Redis).

---

## Accounts, credits & persistence

- **Accounts are admin-managed.** The first admin is seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first run. Sign in, click **Admin**, and add/remove users, set their passwords, and assign credits. There is no public sign-up.
- **Credits.** Every account starts each month with **20,000 credits**. Generation costs **2 credits per image** and **10 credits per video** (so 4 images = 8, 4 videos = 40). A 4K upscale costs another 2. Balances **reset to 20,000 on the 1st of each month**; the admin can top up or set any balance at any time.
- **Persistent feed.** Generated images and videos are saved on the server (under `DATA_DIR`) and reload from `/api/feed`, so your feed survives page refreshes and redeploys. Each item is private to its owner (and the admin). Hover an item to **delete** it from the feed.
- **Security notes.** Passwords are hashed (scrypt) and never stored in plain text; sessions are http-only cookies. This is a straightforward auth system, not a security-audited product — use HTTPS (Railway provides it), set a strong `ADMIN_PASSWORD`, and rotate it if needed.

## Generation modes

There are two top-level tabs — **Image** and **Video** — and the video tab has three sub-modes:

| Tab | Sub-mode | Model | Inputs |
|---|---|---|---|
| **Image** | — | Nano Banana Pro | prompt **+ up to 5 reference images** → up to 4 images |
| **Video** | Text → Video | Veo 3.1 Fast | prompt → up to 4 videos |
| **Video** | Image → Video | Veo 3.1 Fast | an input image (+ optional end frame) + prompt → up to 4 videos |
| **Video** | Ingredients | Veo 3.1 Fast | up to 3 reference images + prompt → up to 4 videos (always 8s) |

## Working with results

- **Per-item controls** — hover any generated image or video for its own buttons:
  - **Download** — saves that specific item, named from the first four words of the prompt (e.g. `a-neon-city-skyline-1.mp4`).
- **Click to enlarge** — click an image (or the expand button on a video) to open it in a large lightbox; close with the × button, the backdrop, or Esc.
- **Use for video / Add as ingredient** — send any generated image into Image→Video (as the input frame) or into Ingredients (up to 3).
  - **Upscale to 4K** (images only) — re-renders the image at 4K via `/api/upscale-image`.
  - **Use for video** (images only) — loads the image into **Video → Image → Video** as the input frame so you can animate a generation you just made.

Video is generated **natively at 1080p** (Veo 3.1 Fast outputs 1080p as a fixed 8-second clip), so there's no separate video upscale step — every clip is already 1080p. Use the **Outputs** control (1–4) to generate up to four variations per prompt, the same as images (each video is a separate paid job).

## Notes & limits

- Veo supports **16:9** and **9:16** only. This app generates video at **1080p**, which Veo produces as an **8-second** clip (the duration picker is therefore fixed at 8s).
- Video generation is asynchronous and typically takes **1–2+ minutes**; the UI shows a progress bar and polls until ready.
- Image reference/upscale features depend on Nano Banana Pro accepting image inputs and 4K output on your account/tier.
- All Google-generated media carries an invisible **SynthID** watermark.
- Costs are billed to your Google account per image / per second of video — keep the output counts low while testing.
