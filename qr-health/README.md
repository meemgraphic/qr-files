# QR health check (daily) + WhatsApp alerts

Every day at **9:00 AM India time** this job:
1. signs in as you (owner PIN),
2. checks every QR you made: the page address, the saved page, the logo, and every button link,
3. saves the result to your dashboard (**Overview → QR health**),
4. sends you a **WhatsApp message** if something is wrong (and another when it's fixed).

It never changes your QRs or pages. It only reads, then writes one report.

## What counts as a problem
- Your QR page address (Netlify site) is down or not the QR page
- A QR's page was deleted
- A button link returns **404 / 410 / server error** or doesn't answer
- A hosted logo is missing
- A phone / WhatsApp / email button looks wrong

Instagram, Facebook, LinkedIn, TikTok and X often refuse automated checks (403/429). Those are **not** reported, so you don't get false alarms. The check can't see inside a site that answers "200 OK" for a missing profile.

## Setup (about 15 minutes, once)

### 1. Publish the new Firestore rules
Firebase console → **Firestore Database → Rules** → paste the contents of `firestore.rules` → **Publish**.
(They add one line so the dashboard can read the reports. Nothing else changes.)

### 2. Get a WhatsApp key (free, CallMeBot)
Open **callmebot.com**, go to the *WhatsApp API* page and follow the "get API key" steps. You send them one WhatsApp message from your phone and they reply with your **API key**.
Your number format for the next step: country code + number, no spaces or +, e.g. `919876543210`.

### 3. Put the checker on GitHub (free)
1. github.com → **New repository** → name it `qr-health` → choose **Private** → Create.
2. Upload everything from this folder (keep the folders `.github`, `netlify`, `scripts`). On the repo page: **Add file → Upload files**. Drag the whole folder content in. The `.github` folder must be kept.
3. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add these:

| Name | Value |
|---|---|
| `OWNER_PIN` | the PIN you use to unlock the dashboard |
| `WA_PHONE` | your number, e.g. `919876543210` |
| `CALLMEBOT_KEY` | the key CallMeBot sent you |
| `SITE_URL` | your dashboard address, e.g. `https://clayncode.netlify.app` |

### 4. Test it
Repo → **Actions** tab → **QR health check** → **Run workflow** → tick **test** → Run.
After about a minute you should get a WhatsApp message, and the dashboard shows the report.

After that it runs by itself every morning. You can also press **Run workflow** any time.

## Good to know
- Keep the repository **Private**. (GitHub pauses scheduled jobs in *public* repos that are inactive for 60 days.)
- GitHub may start the job a few minutes late. That is normal.
- If the check itself can't run (wrong PIN, rules not published), you get a WhatsApp message saying so, and the dashboard shows a red warning when the last report is older than 36 hours.
- Prefer Netlify? `netlify/functions/qr-health.mjs` is a ready scheduled function with the same code. Netlify stops functions after 30 seconds, so GitHub is safer if you have many QRs.
- Using Twilio instead of CallMeBot: add `TWILIO_SID` and `TWILIO_TOKEN` secrets (and `TWILIO_FROM`) and leave `CALLMEBOT_KEY` empty.
- Change the time: edit `cron: "30 3 * * *"` in `.github/workflows/qr-health.yml` (it is UTC; 03:30 UTC = 09:00 India).
