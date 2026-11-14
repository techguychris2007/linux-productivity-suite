# Entertainment Research (Atlas Play, Cinema, Shorts, Library, Streaming Services)

## 1. YouTube

### 1.1 What the policies prohibit (verified)
Source: https://developers.google.com/youtube/terms/developer-policies and the compliance guide https://developers.google.com/youtube/terms/developer-policies-guide

- [VERIFIED] Downloading, importing, backing up, caching or storing copies of YouTube audiovisual content without YouTube's prior written approval.
- [VERIFIED] Letting users download videos for offline playback outside YouTube Premium.
- [VERIFIED] Letting users download or separate audio tracks, or modify the audio or video.
- [VERIFIED] Modifying, adding to or blocking the standard player's playback functions, including hiding links the player normally shows. Overlays are allowed only for consent prompts or playback controls that don't conflict with the player UI, and custom play buttons over a thumbnail must start playback.
- [VERIFIED] Restricting YouTube's ability to verify where playback happens, for example by interfering with playback context signals or cookies.
- [VERIFIED] Policy III.E.4.h: don't use API data to create new or derived data or metrics. On 4 May 2026, YouTube added policies on derived metrics and data storage (revision history).
- [VERIFIED] API clients must show terms of use, state that they use YouTube API Services, and link to the Google Privacy Policy.

### 1.2 Design consequences
- [RECOMMENDATION] **Playback goes only through the official IFrame embed.** No custom video element and no stream extraction.
- [RECOMMENDATION] **Recommendations.** Base "For you" rows on what YouTube's own API returns (search, related or popular endpoints) and on the user's **Atlas-side activity** (what they opened, liked or saved). Don't compute new metrics, such as a quality score, from YouTube statistics. Have this reviewed against III.E.4.h before Milestone 11.
- [RECOMMENDATION] **Data retention.** Store only video IDs and the user's own actions (history, favourites, playlists). Refresh titles and thumbnails from the API rather than keeping long-lived copies. [UNVERIFIED] The exact maximum storage period should be checked against the current policy text.
- [UNVERIFIED] The default Data API quota is 10,000 units per day, and a search call costs 100 units. That allows only about 100 searches a day, so results must be cached within policy limits, and debounced. Confirm the current quota in the Google Cloud console.
- [LIMITATION] **Watch history and subscriptions** from the user's actual YouTube account need OAuth. YouTube's API doesn't return watch history [UNVERIFIED — confirm]. Atlas will therefore keep its own history of what was played inside Atlas.

### 1.3 Technical risk: Error 153 in Tauri
- [VERIFIED] Since late 2025, YouTube embeds fail with "Error 153 – Video player configuration error" when no Referer header is sent (`embedder.identity.missing.referrer`). Fixes are to use `referrerpolicy="strict-origin-when-cross-origin"` and to load from an origin that sends a referrer. Sources: https://til.simonwillison.net/youtube/fixing-153-embed, https://groups.google.com/a/chromium.org/g/chromium-extensions/c/OUJad0q-d_g
- [VERIFIED] Tauri apps load from the `tauri://localhost` custom scheme, which doesn't send a referrer. A 2026 pull request on the Modrinth app documents Error 153 in its Tauri desktop app. A WebKit-based browser (Orion) shows the same error.
- [RECOMMENDATION] **Spike S-ENT-1 (must pass before committing to embedded YouTube):** host the player page from a stable origin. Options are a bundled page served on a `http://127.0.0.1` port, or a small static page on a domain the project controls. Load it in a child webview with `strict-origin-when-cross-origin`. Avoid nested-iframe tricks: [VERIFIED] YouTube forbids placing the player in a nested iframe chain to disguise where it's used (revision history, 2021). **Fallback:** if embedding can't be made compliant and reliable, use "Open in browser" for playback and keep search and discovery in Atlas.

## 2. Netflix and other DRM services
- [VERIFIED] On Linux, Netflix plays in Chrome and Chromium-based browsers out of the box, and in Firefox once Widevine is enabled. Both are capped at 720p by default; 4K isn't available on Linux. Source: https://itsfoss.com/watch-netflix-in-ubuntu-linux/
- [LIMITATION] Tauri's Linux webview, WebKitGTK, has no Widevine CDM [UNVERIFIED as an absolute statement; widely reported], so Netflix **cannot** play inside Atlas.
- [RECOMMENDATION] The **Streaming Services** page is a launcher. Each tile opens the official site in the user's default browser through `xdg-open`, or optionally in a specific browser profile. Atlas stores only the user's own tile arrangement, never credentials. No scraping of catalogues.

## 3. Cinema (authorised and public-domain catalogue)
- [VERIFIED] The Internet Archive offers a free Advanced Search API (`https://archive.org/advancedsearch.php`) and a Metadata API (`https://archive.org/metadata/{identifier}`) without authentication. The `feature_films` collection holds feature films, shorts and silent films (GNOME Grilo issue #45; Archivarix; IA collection page).
- [LIMITATION] Items are uploaded by users. Being in the Archive doesn't prove an item is in the public domain.
- [RECOMMENDATION]
  - Show the item's `licenseurl` and rights fields wherever present. Label each title "Public domain (per source)", "Creative Commons BY…" or "Rights unclear".
  - By default, offer **Download** only for items with an explicit public-domain or Creative Commons licence; Atlas never decides an item's legal status itself.
  - Start from curated collections, such as feature_films and Prelinger, and let the user add more sources.
  - Other candidate sources to evaluate later: Wikimedia Commons video, NASA media, and other national archives. [UNVERIFIED — API details not researched in this pass]

## 4. Atlas Library (personal media)
- [VERIFIED] Jellyfin is GPL-2.0, has official Debian/Ubuntu install docs, includes hardware transcoding, and has a plugin system. Sources: https://jellyfin.org/docs/, https://github.com/jellyfin/jellyfin
- [RECOMMENDATION] Use two modes:
  1. **Built-in mode (default, light):** a Rust/Python scanner reads the folders the user grants, runs `ffprobe` for metadata, and stores the results in SQLite. Playback is direct in the webview where the codecs are supported.
  2. **Jellyfin mode (optional):** if the user runs Jellyfin, Atlas Library connects as a client through its REST API. This gives transcoding, remote access and TV-show metadata. Atlas never bundles or forks Jellyfin.
- [LIMITATION] WebKitGTK plays media through GStreamer, so codec support depends on which GStreamer plugins are installed (e.g. HEVC, AC3). [UNVERIFIED specifics → spike S-ENT-2]. Mitigations: transcode on demand with FFmpeg to H.264/AAC HLS, or use Jellyfin mode, or offer "Open in system player (mpv/VLC)".

## 5. Plex, Kodi, Stremio (studied, not adopted)
[UNVERIFIED — from general knowledge, not re-checked in this pass]
- Plex: proprietary server; useful UX reference only.
- Kodi: GPL; a 10-foot UI and add-on model. Useful reference for remote-friendly navigation.
- Stremio: its add-on ecosystem includes many unauthorised stream sources. **Don't** adopt its add-on model. A protocol that accepts arbitrary stream add-ons would bring a piracy risk Atlas can't control.

## 6. Feature-by-feature legality map

| Requested feature | Status |
|---|---|
| YouTube search, channels, playlists, Shorts discovery | ✅ Through the Data API, within quota |
| YouTube playback | ✅ Official embed only (after spike S-ENT-1) |
| YouTube download / offline | ❌ Not built |
| Netflix inside Atlas | ❌ Launch the browser instead |
| Netflix downloads | ❌ Only in Netflix's own supported apps |
| Public-domain / CC films: stream and download | ✅ With licence labels |
| Personal media: play, organise, subtitles | ✅ |
| "Continue watching", history, favourites | ✅ Atlas-side data |
| Recommendations | ⚠️ Atlas-side signals only; legal review before release |
