# Project Atlas

Project Atlas is a local-first productivity suite for Ubuntu. The available apps are Writer, Sheets, Slides, Drive, Settings, and Atlas AI. Other apps shown in the roadmap are still planned.

Atlas does not include an AI model. You can connect it to Google Gemini, a local OpenAI-compatible model server such as Ollama, or Anthropic Claude. Using a hosted provider sends prompts to that provider; Atlas asks before sending a prompt. A local model can keep prompts on your computer.

## Ubuntu status

The project includes a native Tauri desktop build path. Local `.deb` and AppImage packages can be built; a signed public release is not available yet. Build requirements and install commands are below.

## Run from source on Ubuntu

### Requirements

- Ubuntu 24.04 or newer
- Git
- Rust stable and Cargo
- Node.js 22 or newer, with npm and pnpm 10
- Python 3.12 or newer
- A C compiler and linker (package: build-essential)
- LibreOffice Writer if you want DOCX, ODT, or PDF import/export

Install Ubuntu packages:

~~~bash
sudo apt update
sudo apt install -y build-essential curl git python3 python3-venv libreoffice-writer
~~~

Install Rust stable if it is not already installed:

~~~bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup default stable
~~~

Install Node.js 22 or newer using your preferred Node.js version manager or the official Node.js packages. Install the pnpm version used by this project:

~~~bash
npm install --global pnpm@10.28.0
~~~

### Download and start Atlas

~~~bash
git clone https://github.com/techguychris2007/linux-productivity-suite.git
cd linux-productivity-suite
pnpm install
pnpm dev
~~~

The first run builds the Rust core and web interface. When startup finishes, the terminal prints a local URL. Open it in a browser on the same computer. Atlas binds its development services to 127.0.0.1; keep the terminal open while using it. Press **Ctrl+C** in that terminal to stop Atlas.

### Set up Atlas AI and folders

- Open **Settings → Atlas AI** to choose a provider. For Gemini, create an API key in Google AI Studio and enter it in Settings. For a local provider, start your model server first, then configure its local API URL and model.
- Open **Settings → Folders** and choose which folders Atlas may access. Atlas cannot access folders you have not shared.
- Writer's DOCX, ODT, and PDF import/export features use LibreOffice Writer. If it is missing, install it with sudo apt install libreoffice-writer.

In the development server, provider settings are stored under Atlas's data directory with owner-only file permissions. In the desktop app, provider API keys are stored in Ubuntu's Secret Service keyring. Hosted AI providers receive prompts you choose to send to them; review each provider's privacy terms before use.

## Build and install the native desktop app

Install Tauri's Ubuntu build dependencies ([official prerequisites](https://v2.tauri.app/start/prerequisites/)):

~~~bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
~~~

Then build the .deb and AppImage packages:

~~~bash
pnpm install
pnpm build:desktop
~~~

The packages are written under apps/shell/src-tauri/target/release/bundle/.

To install the .deb and add Atlas to your application launcher:

~~~bash
sudo apt install ./apps/shell/src-tauri/target/release/bundle/deb/*.deb
~~~

For the AppImage, make it executable and launch it:

~~~bash
chmod +x apps/shell/src-tauri/target/release/bundle/appimage/*.AppImage
apps/shell/src-tauri/target/release/bundle/appimage/*.AppImage
~~~

The desktop app starts and stops its local core and engine services with the window. The AppImage still requires a compatible system WebKitGTK library and Python 3.12 or newer.

Writer, Sheets, and Slides use an Office-style ribbon (tabs, groups, File menu, zoom). Writer supports styled documents, font family and size, repeating headers and footers, generated tables of contents, images, find and replace, and DOCX/ODT/PDF export. Sheets supports cell editing, about 110 formula functions, formatting, AutoSum, sorting, charts, CSV and XLSX import/export (including common formats and charts), and Atlas AI spreadsheet tools. Slides supports editable 16:9 text slides, six layouts, five themes, speaker notes, presenter view, and PowerPoint export with notes. Slides files use Atlas's `.atlasdeck` format; importing existing PowerPoint files is not available yet. See the [Milestone 5 report](documentation/development/MILESTONE_5_REPORT.md) and [Office feature inventory](documentation/research/OFFICE_FEATURE_INVENTORY.md) for the current scope and remaining gaps.

## Development checks

~~~bash
pnpm test:core      # Rust security core
pnpm test:engine    # Python engine
pnpm test:e2e       # Browser end-to-end checks
~~~

## Project layout

~~~
apps/shell/            React shell + Tauri desktop wrapper
packages/ui/           Design tokens and shared components
packages/shared-types/ Types shared by UI and engine API
crates/atlas-core/     Rust security core + atlas-core-host
services/engine/       Python Atlas Engine (AI orchestrator)
infrastructure/        Development scripts
documentation/         Research, architecture, decisions, milestone reports
tests/e2e/             End-to-end browser tests
~~~

See [the architecture recommendation](documentation/architecture/ARCHITECTURE_RECOMMENDATION.md) and the milestone reports in documentation/development/ for more detail.

## License

GPL-3.0-or-later. See LICENSE and documentation/development/DECISIONS.md.
