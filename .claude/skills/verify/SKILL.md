---
name: verify
description: Build, launch, and drive this app's real surface (HTTP + browser) to verify a change end-to-end.
---

# Verifying changes in Numbers

Surface = the Next.js server (pages + `/api/*`). Drive it over HTTP/browser; don't
import server modules directly.

## Launch a production server on a throwaway db

```bash
npm run build                       # once; next start reuses .next
export DATA_DIR=/tmp/verify-data DATABASE_URL="file:/tmp/verify-data/verify.db"
export AUTH_SECRET="verify-secret" AUTH_TEST_MODE=1 AI_MOCK=1
npx prisma db push --skip-generate
nohup npx next start -p 3101 & # then poll http://localhost:3101/signin
```

(The `next start` + standalone-output warning is harmless.)

## Drive it

- Log in without Firebase: `POST /api/auth/session` needs a real ID token, but
  `POST /api/auth/test-login {"email":...,"name":...}` (AUTH_TEST_MODE only) sets the same
  `numbers_session` cookie. Keep it in a curl cookie jar (`-c/-b`) for authed requests.
- Sign out: `DELETE /api/auth/session`.
- Browser click-throughs: Playwright is a devDependency; launch chromium with
  `executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium"`.
  Run scripts from inside the repo (bare `@playwright/test` import resolves from script
  location, not cwd) — `data/` is gitignored, a fine scratch spot.

## Gotchas

- `pkill -f "next start -p 3101"` matches your own compound bash command and kills the
  shell (exit 144). Use a bracket pattern: `pkill -f "next start -p 310[1]"` — and keep it
  in a separate Bash call from the `nohup ... &` line.
- Relative SQLite URLs resolve against `prisma/`, not the repo root — use absolute
  `file:` paths for throwaway dbs.
- Fake `FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID` values are enough to render the Google
  button and exercise `/api/auth/session` rejection paths offline.
