# Isai

A personal, ad-free music and podcast player for Android. No account, no tracking, no subscription. Everything is stored on the phone.

**Open the app:** https://capsaarang.github.io/Isai/

## What it does

- **Library:** plays songs you add from your phone (MP3, M4A, FLAC, WAV, OGG). Reads title, artist, album, and cover art. Songs, albums, artists, playlists, liked songs, queue, shuffle, repeat.
- **Podcasts:** search any public show, follow it, stream or download episodes, resume where you left off, speed control, skip 15/30 seconds, sleep timer.
- **Discover:** free legal music from the Internet Archive (Creative Commons, public domain, and live-taping friendly recordings) and Jamendo (independent artists), plus internet radio by language. Save any track to your library for offline listening.
- **Google Drive:** connect a Drive folder in Settings and stream your music without using phone storage. Save songs, albums, or playlists offline when you want them without internet. Isai can only read your Drive, never change it.
- **Listen together:** one phone starts a session and shares a code, the other joins. Play, pause, skip, and seek stay in sync on both phones. Podcasts, radio, and Discover music play on both; your own songs play when both phones have the same song.
- Lock-screen and headphone controls, works offline, installs to the home screen.

## Install on Android

1. Open https://capsaarang.github.io/Isai/ in Chrome.
2. Tap the three-dot menu, then **Add to Home screen** (or **Install app**).
3. Open Isai from the home screen icon.

## Add your songs

1. Keep your music in a folder on the phone (for example `Music/Rajan`).
2. In Isai, tap the upload icon on Home (or **+** in Library).
3. Open the folder, long-press a song, tap **Select all**, then **Select**.
4. Isai copies the songs into its own storage. Importing the same folder again skips songs that are already there.

Keep the original files as a backup. Clearing Chrome's site data removes Isai's copies.

## Listen together

1. Both phones open Isai. Connect the same Google Drive on both, so they share the same songs.
2. One person taps the **Listen together** icon on Home (two people) and taps **Start a session**.
3. Share the code (like `RAGA-7KX2QM`). The other person taps **Listen together**, enters the code, and taps **Join**.
4. Whoever presses play, pause, skip, or seeks becomes the one choosing. Tap the heart in the top banner to send a heart.

Both phones need internet. On iPhone, keep Isai open: locking the screen or switching apps can pause the link until Isai is reopened. Updates pass through free public relay servers (EMQX and HiveMQ), encrypted with a key made from the session code, so the relays can't read them. Only play, pause, skip, seek, hearts, and profile info are sent, never song files.

## Optional: podcast relay (free, about 5 minutes)

Some podcast hosts block web apps from reading their feeds or downloading episodes. The relay fixes that. It's a tiny Cloudflare Worker on the free plan.

1. Sign up at https://dash.cloudflare.com (free).
2. Go to **Workers and Pages**, click **Create**, then **Create Worker**. Name it `isai-relay` and click **Deploy**.
3. Click **Edit code**, delete everything, paste the contents of [`relay-worker.js`](relay-worker.js), and click **Deploy**.
4. Copy the worker URL (looks like `https://isai-relay.<your-name>.workers.dev`).
5. In Isai, open **Settings** (gear on Home), paste it into **Podcast relay URL**, and tap **Save**.

The relay only accepts requests from `capsaarang.github.io`, so nobody else can use it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell and icons |
| `styles.css` | Look and feel |
| `app.js` | All app logic |
| `sw.js` | Offline support |
| `manifest.webmanifest` | Home screen install |
| `relay-worker.js` | Optional Cloudflare relay for podcasts |
| `vendor/jsmediatags.min.js` | Reads song tags and cover art |
| `vendor/mqtt.min.js` | Relay connection for Listen together (MIT) |
