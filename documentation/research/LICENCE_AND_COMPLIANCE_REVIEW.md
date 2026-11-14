# Licence and Compliance Review

> Not legal advice. This is an engineering assessment to decide architecture. Before any public release, have a qualified person review the licence choices.

## 1. Licences of candidate components

| Component | Licence | Evidence | Copyleft strength |
|---|---|---|---|
| ONLYOFFICE Docs / DocumentServer, core, sdkjs, web-apps | AGPL-3.0 (Community); proprietary for Enterprise/Developer editions | [VERIFIED] https://github.com/ONLYOFFICE/DocumentServer, https://github.com/ONLYOFFICE/ | Strong + network clause |
| LibreOffice | MPL-2.0 (also described as dual LGPLv3+/MPL-2.0) | [VERIFIED] https://www.libreoffice.org/about-us/licenses/ (via product docs), Wikipedia infobox | Weak (file-level) |
| Univer (spreadsheet/doc/slide SDK) | Apache-2.0 core; paid "Pro" plugins | [VERIFIED] https://github.com/dream-num/univer | Permissive |
| Tauri 2 | MIT / Apache-2.0 | [UNVERIFIED] — confirm from repo LICENSE files | Permissive |
| ProseMirror / Tiptap core | MIT | [UNVERIFIED] — confirm; note Tiptap sells Pro extensions | Permissive |
| MLT framework (libmlt, mlt++) | LGPL-2.1; melt app and some modules GPL-2/3 | [VERIFIED] https://mltframework.org/docs/copyrightpolicy/ | Weak (core) |
| Kdenlive | GPL-3.0-or-later (parts GPL-2.0+) | [VERIFIED] Wikipedia / KDE COPYING | Strong |
| FFmpeg | LGPL-2.1+ by default; GPL if built with GPL parts (e.g. x264) | [UNVERIFIED] — confirm per build config | Weak/Strong depending on build |
| ComfyUI | GPL-3.0 | [VERIFIED] https://github.com/Comfy-Org/ComfyUI | Strong |
| Wan 2.2 model weights | Apache-2.0 | [VERIFIED] https://ltx.io/blog/open-source-video-generation-models-guide, thundercompute comparison | Permissive |
| LTX-2.x model weights | LTX Model License — free below a USD 10M revenue threshold | [VERIFIED] https://www.thundercompute.com/blog/best-open-source-ai-video-generation-models | Custom/restricted |
| HunyuanVideo | Tencent Community License | [VERIFIED] same source | Custom/restricted |
| Jellyfin | GPL-2.0(-only per packaging metadata) | [VERIFIED] https://github.com/jellyfin/jellyfin, snapcraft metadata | Strong |
| UI-TARS-desktop | Apache-2.0 | [VERIFIED] https://github.com/bytedance/UI-TARS-desktop | Permissive |
| Open Interpreter (current Rust rewrite) | Apache-2.0 (was AGPL-3.0 for the Python era) | [VERIFIED] https://www.promptquorum.com/power-local-llm/open-interpreter-review | Permissive (now) |

## 2. Key compliance findings

### 2.1 ONLYOFFICE's AGPL and its additional terms
- [VERIFIED] ONLYOFFICE Docs is AGPL-3.0, and its Community Edition is recommended for up to about 20 users (https://github.com/onlyoffice/documentserver).
- [VERIFIED] In 2025–2026 there was a public dispute over the additional terms ONLYOFFICE attached to its AGPL code: the logo-retention and trademark clauses, and whether they are allowed under AGPL section 7. Nextcloud reported that ONLYOFFICE later changed the licence text on GitHub (https://nextcloud.com/es/blog/euro-office-license-compliance-and-what-open-source-means/).
- [RECOMMENDATION] If Atlas embeds or modifies ONLYOFFICE code, the combined work must be distributed under AGPL-3.0, and Atlas would have to keep any branding the additional terms require. For a project that wants its **own** branding and freedom over its licence, that's a real constraint. This is one of the reasons the office engine recommendation changes (see TECHNOLOGY_SELECTION.md §3).

### 2.2 Separate processes as the integration boundary
[RECOMMENDATION] Run every copyleft engine (LibreOffice, ComfyUI, MLT/melt, Jellyfin and FFmpeg) as a **separate program**, connected through command-line calls, HTTP or D-Bus. Don't link it into Atlas's own binaries. This:
- keeps licence boundaries clear ("mere aggregation" rather than a combined work — this interpretation needs legal confirmation)
- lets users install, update or swap engines independently
- isolates crashes (LibreOffice and ComfyUI are both large, crash-prone processes)

The one exception is libmlt (LGPL-2.1). Linking to it dynamically is allowed under the LGPL if Atlas does that.

### 2.3 GPL-2.0-only components
[LIMITATION] Jellyfin's packaging metadata says GPL-2.0-only. GPL-2.0-only code cannot be merged into a GPL-3.0 or AGPL-3.0 codebase. Use Jellyfin only through its REST API, as a separate server. Never copy its source.

### 2.4 Model weights are licensed separately from software
[VERIFIED] ComfyUI's GPL-3.0 says nothing about the images and videos it generates. Rights in that output depend on the licence of the model used. Atlas must:
- show each model's licence in Model Manager before it's downloaded
- record the model and its licence in the metadata of every generated asset
- default to Apache-2.0 models (the Wan family) where they're good enough

### 2.5 Platform terms (not software licences)
| Platform | Binding constraint | Evidence |
|---|---|---|
| YouTube API Services | No downloading, caching or storing copies of audiovisual content without written approval. No offline playback outside YouTube Premium. No separating audio tracks. No modifying or blocking the standard player. Don't use API data to create new derived data or metrics. Additional data-storage rules were added on 4 May 2026. | [VERIFIED] https://developers.google.com/youtube/terms/developer-policies, https://developers.google.com/youtube/terms/developer-policies-guide, https://developers.google.com/youtube/terms/revision-history |
| Netflix | Playback only in supported browsers and apps with Widevine. On Linux, that means Chrome or Firefox. | [VERIFIED] https://itsfoss.com/watch-netflix-in-ubuntu-linux/ |
| Internet Archive | APIs are free and need no key, but the rights of each item vary. Not every upload is in the public domain. | [VERIFIED] API facts; [RECOMMENDATION] on rights handling |

## 3. Recommended licence for Atlas itself

| Option | Pros | Cons |
|---|---|---|
| **A. GPL-3.0-or-later** (recommended) | Compatible with ComfyUI, Kdenlive-derived ideas, MLT and LibreOffice (MPL-2.0 is GPL-compatible). Sends a strong open-source signal. | Prevents a proprietary fork later. |
| B. AGPL-3.0 | Would allow embedding ONLYOFFICE code. | Network clause; ONLYOFFICE's branding terms; heavier obligations. |
| C. Apache-2.0 / MIT | Maximum freedom. | Rules out ever merging GPL code; copyleft engines must stay strictly out-of-process (already the plan). |
| D. Proprietary | Full control. | Needs strict out-of-process discipline. Using ONLYOFFICE commercially requires paid editions. |

[RECOMMENDATION] While the repository is private, choose **A (GPL-3.0-or-later)** or **C (Apache-2.0)**. Both work with the out-of-process architecture. **This is your decision** (see the architecture document, "Decisions needed").

## 4. Compliance controls to build in

1. A `THIRD_PARTY_LICENSES` file generated in CI with `cargo-about` and `license-checker` [UNVERIFIED tool names; confirm before use].
2. A CI step that fails the build if a dependency has a licence that isn't on the allow-list.
3. A licence and source field shown on every Cinema item and every generated asset.
4. A YouTube compliance checklist reviewed at each Atlas Play release, covering branding, player integrity, data retention, API-client notices and the privacy-policy link.
5. No code path that fetches googlevideo.com streams, nflxvideo streams or any DRM licence server. Enforce this with a CI test that greps for those hosts.
