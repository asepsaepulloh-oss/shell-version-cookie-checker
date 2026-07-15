# shell-version-cookie-checker

Cookie checker, stealer-log extractor, and Netflix token generator — runs entirely in the terminal. No Telegram bot, no Railway, no server required.

## Features

| Command | What it does |
|---|---|
| `check` | Validates cookies from `.txt` / `.json` / `.zip` files against real service APIs |
| `log` | Extracts domain-specific cookies from stealer log archives (ZIP / RAR / 7z) |
| `nftoken` | Fetches a short-lived Netflix login URL from a `NetflixId` cookie |
| `services` | Lists all 40+ supported services |

## Requirements

- **Node.js 18+**
- **p7zip / 7z** (for RAR and 7z archives — ZIP works without it)
  - macOS: `brew install p7zip`
  - Debian/Ubuntu: `apt install p7zip-full`
  - Replit: pre-installed

## Quick start

```bash
# Clone and install
git clone https://github.com/geminineel/shell-version-cookie-checker.git
cd shell-version-cookie-checker
npm install

# Build
npm run build

# Run
node dist/cli.js --help
```

## Usage

### List supported services

```bash
node dist/cli.js services
```

### Check cookies

```bash
# Auto-detect service from cookies
node dist/cli.js check cookies.zip

# Force a specific service
node dist/cli.js check cookies.txt --service netflix.com

# Save valid cookies to a custom output folder
node dist/cli.js check cookies.zip --service spotify.com --output ./results
```

Valid cookies are saved as ZIPs in the `output/` folder (or `--output <dir>`), grouped by service + plan (e.g. `netflix_premium.zip`).

### Extract logs

```bash
# Extract netflix + spotify cookies from a stealer log ZIP
node dist/cli.js log logs.zip --domains netflix.com,spotify.com

# RAR archive
node dist/cli.js log logs.rar --domains chatgpt.com,discord.com

# Custom output folder
node dist/cli.js log logs.zip --domains netflix.com --output ./extracted
```

### Netflix token URL

```bash
# From a cookie file
node dist/cli.js nftoken netflix_cookies.txt

# From stdin (pipe)
cat netflix_cookies.txt | node dist/cli.js nftoken -
```

The output is a `https://www.netflix.com/browse?nftoken=...` URL valid for ~1 hour. Open it in Chrome or Safari (not inside Telegram or another in-app browser).

## Development

```bash
# Run without building (requires tsx)
npm run dev -- check cookies.zip

# Verbose debug logs
VERBOSE=1 node dist/cli.js check cookies.zip
```

## Supported services (40+)

Run `node dist/cli.js services` for the full list. Includes:

Netflix, Spotify, Disney+, HBO Max, Amazon Prime, Hulu, Crunchyroll, ChatGPT / OpenAI, Discord, Instagram, Facebook, Twitter/X, Roblox, Steam, Epic Games, Minecraft, Ubisoft, EA, Twitch, YouTube Premium, Apple TV, Paramount+, Peacock, Duolingo, Canva, Adobe, Replit, NordVPN, ExpressVPN, and more.
