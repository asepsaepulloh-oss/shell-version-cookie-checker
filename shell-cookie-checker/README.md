# shell-version-cookie-checker

Interactive shell tool with Telegram-style slash commands — no flags, no syntax to memorize. Just run it and type commands.

Supports CDN URLs anywhere a file is expected — paste a download link and it fetches automatically.

## Quick start

```bash
git clone https://github.com/geminineel/shell-version-cookie-checker.git
cd shell-version-cookie-checker
npm install
npm run build
node dist/cli.js
```

## Interactive shell

```
  Cookie Checker Shell
  ────────────────────────────────────────
  Type /help to see commands, /exit to quit

  > 
```

Type commands exactly like Telegram. No `--flags` needed.

## Commands

### `/check` — validate cookies

```
/check <file_or_url> [service]
```

```
/check cookies.zip
/check cookies.txt netflix.com
/check https://cdn.example.com/cookies.zip
/check https://cdn.example.com/netflix.zip netflix.com
```

Accepts `.txt`, `.json`, `.cookies`, or `.zip`. Service is optional — auto-detected if omitted.  
Valid cookies are saved to `output/<service>_<plan>.zip`.

---

### `/log` — extract cookies from stealer logs

```
/log <file_or_url> <domain1> [domain2 ...]
```

```
/log logs.zip netflix.com spotify.com
/log logs.rar discord.com chatgpt.com instagram.com
/log logs.7z netflix.com
/log https://cdn.example.com/logs.zip netflix.com spotify.com
/log https://cdn.example.com/logs.rar netflix.com
```

Accepts `.zip`, `.rar`, `.7z` — local or CDN URL. Extracted cookies saved to `output/<domain>.zip`.

---

### `/nftoken` — Netflix login URL

```
/nftoken <file_or_url>
```

```
/nftoken netflix_cookies.txt
/nftoken https://cdn.example.com/netflix.txt
```

Reads the `NetflixId` cookie and calls the Netflix iOS API to get a short-lived login URL (~1 hour).  
Open the URL in Chrome or Safari — not inside Telegram or any in-app browser.

---

### `/services` — list all supported services

```
/services
```

---

### `/exit` — quit

```
/exit
```

## One-liner mode

You can also pass a command directly without entering the interactive shell:

```bash
node dist/cli.js /check cookies.zip
node dist/cli.js /log logs.zip netflix.com spotify.com
node dist/cli.js /nftoken netflix.txt
```

## Requirements

- **Node.js 18+**
- **p7zip / 7z** for RAR and 7z archives (ZIP works without it)
  - macOS: `brew install p7zip`
  - Debian/Ubuntu: `apt install p7zip-full`
  - Replit: pre-installed

## Development

```bash
npm run dev /check cookies.zip   # run without building (uses tsx)
VERBOSE=1 node dist/cli.js       # enable debug logs
```

## Supported services (40+)

Run `/services` for the full list. Includes Netflix, Spotify, Disney+, HBO Max, Amazon Prime, Hulu, Crunchyroll, ChatGPT/OpenAI, Discord, Instagram, Facebook, Twitter/X, Roblox, Steam, Epic Games, Twitch, YouTube Premium, NordVPN, ExpressVPN, Canva, Adobe, Replit, and more.
