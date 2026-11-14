# Ubuntu Distribution Research

## 1. Supported releases
- [VERIFIED] **Ubuntu 26.04 LTS** (23 Apr 2026, GNOME 50, Wayland-only, kernel 7.0, supported to Apr 2031, minimum 6 GB RAM). The 26.04.1 point release enabled upgrades from 24.04.
- [VERIFIED] xdg-desktop-portal-gnome on GNOME 46+ ships the RemoteDesktop portal used for libei input (wdotool README). GNOME 46 is the version in Ubuntu 24.04.
- [RECOMMENDATION] **Primary target: 26.04 LTS. Secondary: 24.04 LTS,** if spike S-OP-4 passes. Don't support 22.04: its GNOME 42 portal and libei support aren't enough for the Operator [UNVERIFIED in detail].

## 2. Packaging formats (Tauri 2)
- [VERIFIED] Tauri can distribute Linux apps as Debian packages, Snap, AppImage, Flatpak, RPM or AUR (https://tauri.app/distribute/).
- [VERIFIED] The Debian bundle generates the icons and desktop file, and declares dependencies. Extra dependencies and files go in `tauri.conf.json > bundle > linux > deb` (https://v2.tauri.app/distribute/debian/). Tauri recommends building Linux packages in Docker or GitHub Actions.
- [VERIFIED] AppImage bundles its dependencies, which makes it 70+ MB rather than 2–6 MB. The `bundleMediaFramework` option includes GStreamer, which increases the size and raises licensing concerns over the "ugly" plugins.
- [VERIFIED] Flatpak isn't a direct `tauri build` target: build a deb or AppImage first, then package it with flatpak-builder and a manifest.
- [VERIFIED] To keep glibc compatible, build on the **oldest** supported distribution. Tauri has no supported way to cross-compile Linux packages locally.

| Format | Priority | Notes for Atlas |
|---|---|---|
| **.deb** | 1 | Best integration. Declares dependencies (`libwebkit2gtk-4.1-0`, `gstreamer1.0-plugins-good`, `ffmpeg`, `libreoffice-core` as Recommends, `at-spi2-core`, `xdg-desktop-portal-gnome`, `python3`). The package names must be [UNVERIFIED against 24.04/26.04 archives]. |
| **AppImage** | 2 | Portable. Can't declare system dependencies, so LibreOffice, FFmpeg and the Python runtime are either bundled (bigger) or detected at runtime with a setup assistant. |
| Flatpak | 3 (optional) | [RECOMMENDATION] Defer. The sandbox conflicts with Operator features (portals still work), launching host processes such as LibreOffice and ComfyUI, and broad filesystem access. That would need `flatpak-spawn --host`, which defeats the sandbox. |
| Snap | Not planned | Similar confinement issues. |

## 3. Python sidecar packaging
[RECOMMENDATION] The FastAPI "Atlas Engine" ships as a **self-contained Python environment** inside the package, for example a relocatable CPython build with a venv [UNVERIFIED best tool: `python-build-standalone`, PyInstaller or Nuitka → spike S-DIST-1]. It's launched as a Tauri sidecar. Heavy machine-learning dependencies (torch) are **not** bundled: local models run in separately installed services (Ollama/llama.cpp, ComfyUI).

## 4. CI/CD (GitHub Actions)
- Matrix: `ubuntu-24.04` runner to build (glibc baseline), plus test jobs on 24.04 and 26.04 containers.
- Steps: lint → unit tests (Rust, TS, Python) → build frontend → `tauri build --bundles deb,appimage` → install the .deb in a clean container and run a smoke test (launch headless with `xvfb-run` or a Wayland headless compositor [UNVERIFIED]) → generate SHA256SUMS → attach to a draft GitHub Release.
- Releases contain: `.deb`, `.AppImage`, `SHA256SUMS`, release notes, minimum requirements and install instructions. Instructions are published only after a successful install test.

## 5. Spikes
| Spike | Pass criteria |
|---|---|
| S-DIST-1 Python sidecar in .deb | Clean 26.04 VM: `apt install ./atlas.deb`, the app starts, the sidecar responds, and nothing is written outside `~/.local/share/atlas` |
| S-DIST-2 AppImage on 24.04 and 26.04 | Starts and plays a local MP4 in the webview |
