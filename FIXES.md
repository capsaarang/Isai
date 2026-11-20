# Fixes log

## 2026-11-08 (nightly check)
- Problem: when the shared sync file couldn't be read for a moment (network or Google error), Isai wrote this phone's copy over it, wiping likes and playlists the other phone had just added.
  Fix: if the file can't be read, skip that sync round and try again later (a missing file is still recreated as before).
- Problem: Isai's service worker deleted every offline cache on capsaarang.github.io, including Iris's, so Iris could fail to open offline after an Isai update.
  Fix: only delete Isai's own old caches.
- Version: 1.9.4 (cache isai-v1.9.4). Commit: f94d653
- Also checked: Drive scan keeps the library when Drive returns an empty list, a much smaller list, a missing folder or a different account. Removals of up to 20 songs (or under 30%) still go through, by design.

## 2026-11-16 (manual check)
- No issues found. Re-tested Drive scan safety (empty list, wrong account, missing folder), new-song scan, lyrics (song tags and .lrc), recaps.

## 2026-11-20 (usability improvements, 1.10.0)
- Settings: everyday settings first; Jamendo Client ID and podcast relay moved under Advanced.
- Added: keep playing similar songs when the queue ends (same artist, album or folder, then liked songs). Can be turned off in Settings, Playback.
- Added: move songs up and down in the queue.
- Added: Edit song details (title, artist, album) from a song's menu. Saved on this phone; the Drive file is unchanged; a rescan keeps the edit.
- Added: Your stats tile on Home.
- Added: recent searches on the Search screen.
- Faster Library: long song lists build in chunks as you scroll, and covers load only as they come on screen.
- Re-tested: Drive scan safety, new-song scan, lyrics, recaps. All passed.
