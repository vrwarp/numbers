# Push notifications — deployment setup

The step-by-step console walkthrough promised by
`docs/NOTIFICATIONS_DESIGN.md` §13, written for someone who has never opened
the Google Cloud IAM screen. Doing these steps out of order is fine; granting
a broader role instead of the custom one is **not** — see the warning box.

The app runs fully without any of this: badges and the in-app activity list
are the baseline. Push is an optional acceleration layer.

## What you'll end up with

| Config key | What it is | Where it goes |
| --- | --- | --- |
| `FIREBASE_MESSAGING_SENDER_ID` | Public sender id | env or Admin → Settings |
| `FIREBASE_VAPID_PUBLIC_KEY` | Public Web Push certificate key | env or Admin → Settings |
| `FCM_SERVICE_ACCOUNT_JSON` | The messaging-only service-account key (SECRET) | **`<data>/config.json`** via Admin → Settings (multi-line JSON does not survive compose-env quoting well) |

## 1. Web Push certificate + sender id (2 minutes)

1. [Firebase console](https://console.firebase.google.com) → your project →
   ⚙ **Project settings** → **Cloud Messaging** tab.
2. Copy the **Sender ID** → `FIREBASE_MESSAGING_SENDER_ID`.
3. Under **Web configuration → Web Push certificates**, click
   **Generate key pair** (if none exists). Copy the key →
   `FIREBASE_VAPID_PUBLIC_KEY`.

## 2. The custom IAM role — do this FIRST, before the service account

> **Why so careful?** The e-sign design's core guarantee is that this server
> can never read or write the signature ledger in Firestore. A service
> account with a broad role ("Firebase Admin", "Editor", "Owner") *can*, and
> would silently void that guarantee. The custom role below can do exactly
> one thing: send push messages. The admin health card checks this and shows
> a red warning if the account can do more.

1. [Google Cloud console](https://console.cloud.google.com) → pick the same
   project → ☰ menu → **IAM & Admin** → **Roles** → **+ Create role**.
2. Title: `Push sender` (any name works). ID: leave the default.
3. **+ Add permissions** → in the filter type
   `cloudmessaging.messages.create` → tick that ONE permission → **Add**.
4. **Create**.

## 3. The service account + key

1. **IAM & Admin** → **Service accounts** → **+ Create service account**.
2. Name: `numbers-push` (anything). **Create and continue**.
3. Role: **Custom** → pick *Push sender* (the role from step 2). **Done**.
   Grant nothing else. No user access.
4. Open the new account → **Keys** tab → **Add key** → **Create new key** →
   **JSON** → download. This file is a secret — treat it like a password.

## 4. Give it to the app

Recommended path (no shell quoting, hot-reloads without a restart):

1. Sign in to Numbers as an admin → **Admin** → **Settings** →
   **Push notifications** group.
2. Paste the sender id and Web Push key into their fields.
3. Open the downloaded JSON file in a text editor, copy **the whole thing**,
   paste it into **Messaging service account (JSON)**. Save.

(The values land in `<data>/config.json`; the field is write-only — the UI
shows only that a value is set.)

## 5. Verify

1. The **Push notification health** card (same Settings tab) should show
   status *Sending* and “Service account is messaging-only — as designed.”
   A red warning here means step 2/3 went wrong — delete the key, fix the
   role, make a new key.
2. On your phone: Profile → Notifications → turn on →
   **Send myself a test notification**.

## Operational notes

- **Pause everything** (incident switch): Admin → Settings →
  *Pause all sending*. Events keep recording; nothing is delivered; unpausing
  never fires stale notifications.
- **Quiet hours** exist but ship OFF (`NOTIFY_QUIET`, e.g.
  `21:30-08:00,sun:09:00-12:30`, server time) — phones' own Do-Not-Disturb is
  usually the better tool. Device security alerts are never held.
- **Key rotation**: if the SA key may have leaked, delete the key in the
  console (sends stop immediately), create a new key, paste it in. Off-server
  sends by a stolen key are NOT visible in the health card — rotation is the
  only remedy.
- **iPhones** receive push only from the installed Home-Screen app
  (iOS 16.4+). The app walks users through this — see
  `docs/NOTIFICATIONS_DESIGN.md` §8.4.
