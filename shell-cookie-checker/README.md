# 🍪 Cookie Checker

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/geminineel/shell-version-cookie-checker/blob/main/CookieChecker_Colab.ipynb)

Check cookies, extract stealer logs, and grab Netflix tokens — runs in Google Colab (fastest free option) or in any terminal.

---

## 🚀 Google Colab (Recommended — Fastest)

**Click the badge above** or go to:
```
https://colab.research.google.com/github/geminineel/shell-version-cookie-checker/blob/main/CookieChecker_Colab.ipynb
```

1. Click **"Open in Colab"**
2. Run **Cell 1 (Setup)** — takes ~60 seconds, once per session
3. Upload your file or paste a CDN URL
4. Run `/check`, `/log`, or `/nftoken` cells

> **Paste tip:** Use `Ctrl+V` to paste in Colab — right-click paste is blocked by the browser.

---

## 💻 Terminal / Local

```bash
git clone https://github.com/geminineel/shell-version-cookie-checker.git
cd shell-version-cookie-checker
npm install
npm run build
node dist/cli.js
```

---

## Commands

### `/check` — Validate cookies

```
/check <file_or_url> [service]
```

```
/check cookies.zip
/check cookies.txt netflix.com
/check https://cdn.example.com/cookies.zip
```

Accepts `.txt`, `.json`, `.cookies`, `.zip`. Service is optional — auto-detected if omitted.
Valid cookies saved to `output/<service>_<plan>.zip`.

---

### `/log` — Extract cookies from stealer logs

```
/log <file_or_url> <domain1> [domain2 ...]
```

```
/log logs.zip netflix.com spotify.com
/log logs.rar discord.com chatgpt.com
/log https://cdn.example.com/logs.zip netflix.com spotify.com
```

Accepts `.zip`, `.rar`, `.7z` — local path or CDN URL. Results saved to `output/<domain>.zip`.

---

### `/nftoken` — Netflix login URL

```
/nftoken <file_or_url>
```

```
/nftoken netflix_cookies.txt
/nftoken https://cdn.example.com/netflix.txt
```

Reads `NetflixId` cookie → calls Netflix iOS API → returns a login URL (~1 hour valid).
Open in Chrome or Safari (not in-app browser).

---

### `/services` — List all supported services

```
/services
```

---

### `/exit` — Quit

```
/exit
```

---

## One-liner mode (no interactive shell)

```bash
node dist/cli.js /check cookies.zip
node dist/cli.js /log logs.zip netflix.com spotify.com
node dist/cli.js /nftoken netflix.txt
```

---

## Requirements

- **Node.js 18+**
- **p7zip / 7z** for RAR and 7z archives (ZIP works without it)
  - Ubuntu/Colab: `apt install p7zip-full`
  - macOS: `brew install p7zip`

---

## Supported services (40+)

Netflix, Spotify, Disney+, HBO Max, Amazon Prime, Hulu, Crunchyroll, ChatGPT/OpenAI, Discord, Instagram, Facebook, Twitter/X, Roblox, Steam, Epic Games, Twitch, YouTube Premium, NordVPN, ExpressVPN, Canva, Adobe, Replit, and more.

Run `/services` for the full list.
