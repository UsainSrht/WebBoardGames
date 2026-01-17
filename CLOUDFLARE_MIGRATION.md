# Cloudflare Migration Guide for Web Board Games

## Project Structure After Migration

```
webboardgames/
├── wrangler.toml          # Cloudflare Workers config
├── package.json           # Updated with Cloudflare scripts
├── public_html/           # Static files (served by Cloudflare Pages)
│   ├── socket-client.js   # WebSocket client (replaces Socket.IO)
│   ├── index.html         # Updated to use socket-client.js
│   ├── game.html          # Updated to use socket-client.js
│   └── games/
├── src/                   # Cloudflare Workers code
│   ├── worker.js          # Main worker entry point
│   ├── durable-objects/
│   │   └── GameRoom.js    # WebSocket + game state management
│   └── games/             # Game logic (Cloudflare-compatible)
│       ├── rock-paper-scissors.js
│       ├── hamsterball.js
│       └── kingdomino.js
└── server.js              # Legacy (kept for reference)
```

## What's Been Done ✅

1. ✅ Created `wrangler.toml` - Cloudflare Workers configuration with Durable Objects
2. ✅ Created `src/worker.js` - Main worker handling routes and WebSocket upgrades
3. ✅ Created `src/durable-objects/GameRoom.js` - Replaces Socket.IO rooms
4. ✅ Created Cloudflare-compatible game modules in `src/games/`
5. ✅ Created `public_html/socket-client.js` - WebSocket client mimicking Socket.IO API
6. ✅ Updated `package.json` - Added Cloudflare scripts, removed Node.js server deps
7. ✅ Updated `.gitignore` - Added Cloudflare-specific ignores
8. ✅ Updated `index.html` and `game.html` - Changed from Socket.IO CDN to socket-client.js

---

## What You Need to Do 📋

### Step 1: Authenticate with Cloudflare (API Token Method)

Since OAuth login failed, use an API token instead:

1. **Go to Cloudflare Dashboard**: https://dash.cloudflare.com/profile/api-tokens
2. **Click "Create Token"**
3. **Use the "Edit Cloudflare Workers" template** (or create custom)
4. **Required Permissions**:
   - Account → Workers Scripts → Edit
   - Account → Workers KV Storage → Edit
   - Account → Workers Routes → Edit
   - Account → Durable Objects → Edit (if available)
   - Zone → Zone → Read (if using custom domain)
5. **Copy the token** (you'll only see it once!)

6. **Set the token in your terminal**:
```powershell
# Option A: Environment variable (temporary)
$env:CLOUDFLARE_API_TOKEN = "your-token-here"

# Option B: Save to wrangler config (persistent)
npx wrangler config
# Then paste your token when prompted
```

### Step 2: Test Locally
```powershell
npm run dev
```
Visit http://localhost:8787

### Step 3: Deploy to Cloudflare
```powershell
npm run deploy
```

---

## Cloudflare Dashboard Steps 🌐

### 1. Create Account (if needed)
1. Go to https://dash.cloudflare.com/sign-up
2. Create a free account
3. Verify your email

### 2. Create API Token
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Select **Edit Cloudflare Workers** template
4. Click **Continue to Summary** → **Create Token**
5. **Copy the token immediately!**

### 3. After First Deployment
1. Go to **Workers & Pages** in dashboard
2. Click your worker (`web-board-games`)
3. You'll see the deployment URL (e.g., `web-board-games.your-subdomain.workers.dev`)

### 4. Custom Domain (Optional)
1. In your worker settings, go to **Triggers** tab
2. Click **Add Custom Domain**
3. Enter your domain (must be on Cloudflare DNS)

### 5. Monitor Usage
1. Go to your worker → **Analytics**
2. Check request counts, CPU time, etc.

---

## Alternative: Manual Wrangler Config

If environment variable doesn't work, create a `.wrangler.toml` file in your home directory or use:

```powershell
# This will prompt for your credentials
npx wrangler login --api-token

# Or set in current session
$env:CLOUDFLARE_API_TOKEN = "your-token-here"
npx wrangler whoami
```

---

## Free Plan Limits 📊

| Feature | Free Limit |
|---------|------------|
| Worker Requests | 100,000/day |
| Durable Object Requests | 1 million/month |
| Durable Object Storage | 1 GB |
| WebSocket Messages | Counted as requests |
| CPU Time | 10ms per request |

**Important for Games:**
- Each WebSocket message = 1 request
- Hamsterball's 30 FPS = ~30 requests/sec per player
- Consider reducing update rate for production

---

## Troubleshooting

### "ECONNRESET" or "Failed to fetch" during login
→ Use API token method instead of OAuth (see Step 1)

### "Durable Objects are not enabled"
→ They're enabled automatically on first deploy. Just run `npm run deploy`

### "WebSocket connection failed"
→ Check that wrangler is running: `npm run dev`
→ Verify URL is `ws://localhost:8787/ws?room=ROOMCODE`

### "Authentication required"
→ Make sure CLOUDFLARE_API_TOKEN is set:
```powershell
echo $env:CLOUDFLARE_API_TOKEN
```

---

## Local Development

```powershell
# Start local development server
npm run dev

# View real-time logs from deployed worker
npm run tail
```

---

## Quick Reference Commands

```powershell
# Check if authenticated
npx wrangler whoami

# Deploy
npm run deploy

# View logs
npm run tail

# Local dev
npm run dev
```
