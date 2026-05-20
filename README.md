# Crowdworks Auto Bid — Chrome Extension

A Chrome (Manifest V3) extension that monitors a Google Sheet, and for every new
row generates a bid with an AI provider and submits it on Crowdworks.

- **Title** → column **C** (the cell's hyperlink is the Crowdworks job URL)
- **Quote / budget** → column **D**
- **Details** → column **E**

## How it works

1. The background worker polls the sheet on an interval (1s–30s).
2. New rows added after **Start** are detected and queued.
3. The selected AI provider returns a JSON `{ price, message }` bid.
4. The job page is opened in a background tab; `content.js` fills the proposal
   form and submits it.

Bids are processed **one at a time** so tabs/forms don't collide.

## Setup

### 1. Share the sheet with the service account
Auth uses the bundled `service_account.json` (project `autocloudbid`).
Open the Google Sheet → **Share** → add this address as **Viewer**:

```
cw-452@autocloudbid.iam.gserviceaccount.com
```

Also make sure the **Google Sheets API** is enabled in the `autocloudbid`
Google Cloud project.

### 2. Load the extension
`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
this folder. (`service_account.json` must stay in the folder.)

### 3. Configure (extension popup)
1. **AI Provider** — ChatGPT (OpenAI) / Gemini / Claude / Cursor.
2. **API Key** — per provider; Save / Edit / Clear.
3. **Model** — per provider.
4. **Prompt** — uses `{title}`, `{budget}`, `{detail}` placeholders; Save / Edit / Clear.
5. **Test mode** — skip the AI and bid with a fixed text (no API key needed).
   The bid price is taken from column D (the quote).
6. **Sheet URL**, **check interval**, **Auto-submit** → *Save settings*.
7. **Start** to begin monitoring, **Stop** to end.

You must also be **logged into crowdworks.jp** in the same Chrome profile.

## Important notes / limitations

- **Crowdworks form selectors are best-effort.** The proposal form's DOM varies
  by job type and changes over time. If bids aren't filled correctly, open a
  proposal page, inspect the fields with DevTools, and edit `SELECTORS` in
  [content.js](content.js).
- **Polling, not push.** Chrome extensions can't subscribe to Sheets changes.
  `chrome.alarms` can't fire faster than every 30s, so an offscreen document
  (`offscreen.html` / `offscreen.js`) runs a `setInterval` to allow 1s polling.
- **Sheets API quota:** ~60 reads/minute per user. Polling every 1s sits right
  at that limit and may cause `429` errors — use 2–3s if you see "Poll error"
  rate-limit messages in the log.
- **Cursor** has no official public completion API — that option is wired as an
  OpenAI-compatible call.
- **Security:** `service_account.json` contains a private key. Anyone with this
  folder can read the sheet as that service account. Keep the folder private and
  do not publish the extension with the key inside.
- Automated bidding may conflict with Crowdworks' Terms of Service — review them
  before running this on a real account.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest |
| `background.js` | Sheets polling, AI calls, bid orchestration |
| `content.js` | Fills & submits the Crowdworks proposal form |
| `offscreen.html/.js` | Sub-30s polling timer (offscreen document) |
| `notification.html/.js` | Green "bid completed" popup window |
| `popup.html/.css/.js` | Extension UI |
| `service_account.json` | Google service-account credentials |
