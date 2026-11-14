# Project Atlas — Phase 0 Research Pack

Research date: 14 November 2026
Status: **Draft for review.** No application code has been written. Implementation starts only after you approve this research and the architecture.

## How to read these documents

Every claim is labelled with one of these tags:

| Tag | Meaning |
|---|---|
| **[VERIFIED]** | Checked against a source in this research pass. The source link appears next to the claim. |
| **[RECOMMENDATION]** | An engineering judgement drawn from the verified facts. |
| **[UNVERIFIED]** | Comes from general engineering knowledge and was not re-checked in this pass. Verify it before relying on it. |
| **[LIMITATION]** | A technical or legal constraint that affects scope. |
| **[PAID]** | Needs a paid service or subscription. |
| **[EXTERNAL-AI]** | Needs an external model or API, or local hardware above typical consumer specifications. |

## Documents

| # | Document | What it answers |
|---|---|---|
| 1 | [PRODUCT_COMPARISON.md](PRODUCT_COMPARISON.md) | What the office suites do well, and what Atlas should and shouldn't copy |
| 2 | [GITHUB_REPOSITORY_AUDIT.md](GITHUB_REPOSITORY_AUDIT.md) | For each candidate repository: reuse it, integrate it, fork it, or only study it |
| 3 | [AI_AGENT_RESEARCH.md](AI_AGENT_RESEARCH.md) | How Atlas AI should plan, call tools and verify its work |
| 4 | [COMPUTER_AUTOMATION_RESEARCH.md](COMPUTER_AUTOMATION_RESEARCH.md) | How the Operator can see the screen and control input on Wayland-only Ubuntu |
| 5 | [VIDEO_ENGINE_RESEARCH.md](VIDEO_ENGINE_RESEARCH.md) | The editing engine for Video Studio, and AI video generation |
| 6 | [ENTERTAINMENT_RESEARCH.md](ENTERTAINMENT_RESEARCH.md) | YouTube, Netflix, Jellyfin and public-domain sources |
| 7 | [UBUNTU_DISTRIBUTION_RESEARCH.md](UBUNTU_DISTRIBUTION_RESEARCH.md) | Target Ubuntu releases, packaging and CI |
| 8 | [LICENCE_AND_COMPLIANCE_REVIEW.md](LICENCE_AND_COMPLIANCE_REVIEW.md) | Licence compatibility and the licence Atlas itself should use |
| 9 | [TECHNOLOGY_SELECTION.md](TECHNOLOGY_SELECTION.md) | The final stack, including where it departs from the proposal |
| — | [../architecture/ARCHITECTURE_RECOMMENDATION.md](../architecture/ARCHITECTURE_RECOMMENDATION.md) | The architecture, risks, revised milestones and the decisions needed from you |

## Six findings that change the original plan

1. **Ubuntu 26.04 LTS has no X11 session.** GNOME 50 runs only on Wayland, so tools like xdotool and pyautogui cannot control native windows. The Operator must use the XDG RemoteDesktop/ScreenCast portals with libei, and AT-SPI2.
2. **The ONLYOFFICE engine is licensed AGPL-3.0, and it's a heavyweight server stack.** It also hides its document model from Atlas AI. The recommendation is to own the document model with permissively licensed editors, and to use LibreOffice in headless mode for converting to and from Office formats.
3. **Tauri on Linux runs on WebKitGTK, which has no Widevine DRM.** Netflix therefore cannot play inside Atlas and must open in Chrome or Firefox. YouTube embeds also fail with Error 153 when the page origin is `tauri://`. Both need an early technical spike.
4. **The YouTube policies limit more than downloads.** They also restrict creating derived data or metrics from API data, and storing that data. That limits how a recommendation engine can use YouTube data, so legal review is needed before building recommendations.
5. **Open Interpreter is no longer a computer-control tool.** In 2026 it was rewritten in Rust as an Apache-2.0 coding agent. The original Python tool survives only as a community fork. Study it; don't build on it.
6. **Local AI video generation depends on the GPU.** Wan 2.2's 5B model fits in about 8 GB of VRAM. The officially stated minimum for the 14B text-to-video model is 80 GB. Atlas needs hardware tiers and remote-provider options.
