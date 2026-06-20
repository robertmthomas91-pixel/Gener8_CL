#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "▶ GENER8 setup"
if ! command -v node >/dev/null 2>&1; then echo "✗ Node.js not installed. Get it from https://nodejs.org (v20+)."; exit 1; fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then echo "✗ Node $(node -v); v20+ required."; exit 1; fi
[ -f .env ] && { set -a; . ./.env; set +a; }
if [ -z "$GEMINI_API_KEY" ]; then
  echo ""; echo "No Gemini API key found yet."
  echo "Get one at https://aistudio.google.com/apikey (enable billing — Nano Banana Pro & Veo are paid)."; echo ""
  printf "Paste your Gemini API key and press Enter (or Enter to start without it): "
  read -r KEY_INPUT
  if [ -n "$KEY_INPUT" ]; then printf 'GEMINI_API_KEY=%s\nADMIN_EMAIL=admin@gener8.app\nADMIN_PASSWORD=change-me\nDATA_DIR=./data\nPORT=3000\n' "$KEY_INPUT" > .env; export GEMINI_API_KEY="$KEY_INPUT"; echo "✓ Saved .env (edit it to set your admin email/password)."; else echo "⚠  Starting without a key."; fi
  echo ""
fi
if [ ! -d node_modules ]; then echo "▶ Installing dependencies…"; npm install; else echo "▶ Dependencies already installed."; fi
echo "▶ Starting GENER8… open http://localhost:3000 and sign in as admin (see server output for the password if you didn't set one)."
exec npm start
