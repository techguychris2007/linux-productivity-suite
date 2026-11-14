# Computer Automation Research (Atlas Operator)

## 1. The platform reality in November 2026

- [VERIFIED] Ubuntu 26.04 LTS "Resolute Raccoon" was released on 23 April 2026 with GNOME 50 and kernel 7.0. It is the first Ubuntu LTS **without an Xorg desktop session**. X11 apps still run through XWayland. Sources: https://www.omgubuntu.co.uk/2026/04/ubuntu-26-04-lts-released, https://www.theregister.com/2026/03/19/gnome_50/
- [VERIFIED] GNOME 50 cannot be logged into with X11 at all, even if X.org is installed manually (The Register).
- [VERIFIED] 26.04 is supported until April 2031, and the 26.04.1 point release opened upgrades from 24.04 (computingforgeeks; linuxconfig).
- [VERIFIED] Ubuntu 26.04 Desktop requires at least 6 GB of RAM (linuxconfig.org).

**Consequence:** [LIMITATION] xdotool, pyautogui, pynput and other XTest tools can **only** reach X11 apps running under XWayland. They cannot see or control native Wayland windows, and they cannot take full-screen screenshots.

## 2. What Wayland does provide

| Capability | Mechanism | Status | Evidence |
|---|---|---|---|
| Screen capture | XDG Desktop Portal **ScreenCast** → PipeWire stream | Mature | [VERIFIED] https://github.com/johnohhh1/portal_use |
| One-off screenshot | XDG **Screenshot** portal | Mature | [VERIFIED] pyguitest docs (pypi) |
| Pointer & keyboard injection | XDG **RemoteDesktop** portal → `ConnectToEIS` → **libei** | Production since libei 1.0 (2023). Supported by xdg-desktop-portal-gnome on GNOME 46+ and xdg-desktop-portal-kde on Plasma 6. | [VERIFIED] https://github.com/cushycush/wdotool, https://perrette.github.io/scribe/roadmap-libei/, https://lists.freedesktop.org/archives/wayland-devel/2025-May/044241.html |
| UI structure (buttons, menus, roles, names) | **AT-SPI2** over D-Bus (pyatspi / PyGObject `Atspi`) | Mature; GTK, Qt and Electron/Chromium publish trees. Toolkit accessibility must be enabled. | [VERIFIED] https://wiki.freedesktop.org/www/Accessibility/AT-SPI2/, https://fedoramagazine.org/automation-through-accessibility/ |
| Window coordinates | Not exposed by Wayland. dogtail uses `gnome-ponytail-daemon`, which goes through the remote-desktop and screencast APIs. | Workaround | [VERIFIED] Fedora Magazine |
| Kernel-level fallback | `/dev/uinput` (ydotool). Needs the input group and a daemon; no consent prompt. | Works, but bypasses compositor consent | [VERIFIED] scribe roadmap; tine README |

[VERIFIED] The portal route asks the user for consent. With session persistence, the user approves once and the session stays alive (portal_use write-up). [RECOMMENDATION] This consent prompt suits Atlas's permission model: the user explicitly grants "Atlas may control this desktop".

[LIMITATION] The input-method protocol differs on GNOME: GNOME doesn't implement `input_method_v2` (GNOME Discourse thread). With libei, the compositor owns the keymap, so characters outside the active keyboard layout may be dropped (wdotool README). For text entry, prefer AT-SPI `EditableText.insertText` or the clipboard and paste, and use synthetic keystrokes only for shortcuts.

## 3. Existing projects surveyed

| Project | What it shows | Licence | Use |
|---|---|---|---|
| portal_use (johnohhh1) | Full Wayland stack: ScreenCast + libei + AT-SPI2 + Tesseract OCR behind MCP. Tested on Ubuntu 26.04 RC / GNOME 50. | check repo | **Study** — closest reference architecture |
| tine (smythp) | GNOME Wayland agent driver: AT-SPI tree + uinput injection, no portals. Alpha. | check repo | **Study** — shows the trade-off of skipping consent |
| wdotool (cushycush) | xdotool-like CLI over the RemoteDesktop portal and libei | check repo | **Study or optional dependency** |
| eitype | Rust libei typing through the portal | Apache-2.0 | **Study / possible dependency** |
| dogtail + gnome-ponytail-daemon | AT-SPI automation framework used for GNOME QA | GPL [UNVERIFIED] | **Study**; use pyatspi directly |
| UI-TARS / UI-TARS-desktop | Vision-language GUI agent: screenshot → grounded action | Apache-2.0 | **Integrate the model** as an optional grounding provider through an OpenAI-compatible endpoint. Don't fork the app. |
| Open Interpreter | Now a Rust coding agent; the computer-control Python version is a community fork | Apache-2.0 (new) | **Study only** |
| Playwright | Browser automation through CDP/WebDriver | Apache-2.0 [UNVERIFIED] | **Use** for browser workflows Atlas launches itself |

## 4. Recommended Operator architecture

[RECOMMENDATION] Use a layered "best available signal" approach. Each layer sits behind one `OperatorBackend` interface, so backends can be swapped.

```
Level 0  Atlas's own apps      → DIRECT TOOLS (no GUI automation at all)
Level 1  Browser tasks          → Playwright on an Atlas-launched browser profile
Level 2  Accessible native apps → AT-SPI2: find by role/name → action interface
                                  (doAction / insertText / setCurrentValue)
Level 3  Anything else          → ScreenCast frame → VLM grounding (local UI-TARS
                                  or a cloud model) → libei pointer/keyboard via portal
Fallback (opt-in, dev only)     → ydotool/uinput, disabled by default
```

The **observe → act → verify** loop at every level:
1. Observe: AT-SPI snapshot, plus a screenshot when needed.
2. Propose an action as a structured object, e.g. `{kind: "click", target: {role, name, bbox}, reason}`.
3. Policy check by the Rust permission broker: what app, what action and what risk tier.
4. Execute.
5. Verify the expected state change, such as a focus change, an AT-SPI state, or a pixel diff. Retry at most N times, then hand control back to the user.

### "Visible operation" inside Atlas apps
[RECOMMENDATION] For Atlas's own applications, **don't** drive the real cursor. Run direct tools, and have the frontend draw a **ghost cursor and highlight** that animates to the control each tool call affects. The user still watches the AI working, and execution stays exact, fast and testable. Real cursor control is used only for external apps, or when the user explicitly asks for it.

### Interrupt and take control
- A global hotkey (registered through the GlobalShortcuts portal [UNVERIFIED availability on GNOME 50 — spike]) plus an always-on-top Stop button in the activity panel.
- Any physical user input detected during Operator control pauses the run. Detection mechanism to be confirmed in a spike.

## 5. Spikes required before Milestone 3 (Operator MVP)

| Spike | Pass criteria |
|---|---|
| S-OP-1 RemoteDesktop + libei on Ubuntu 26.04 / GNOME 50 | Move the pointer, click and type ASCII into gedit after a single consent prompt; the session persists across Atlas restarts |
| S-OP-2 ScreenCast frames into Python/Rust | Under 200 ms latency per frame on 1080p |
| S-OP-3 AT-SPI tree of Firefox, Files (Nautilus), LibreOffice, a Qt app | Find and activate a named button in each |
| S-OP-4 Ubuntu 24.04 / GNOME 46 | The same as S-OP-1. This decides whether 24.04 stays a supported target |
