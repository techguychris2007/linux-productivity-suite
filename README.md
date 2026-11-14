# Project Atlas

Project Atlas is a local-first productivity suite for Ubuntu. The current milestone includes the Atlas shell, a permission-controlled file access core, an AI assistant, and Writer with document import and export. Sheets, Slides, and other planned apps are not available yet.

Atlas does not include an AI model. You can connect it to Google Gemini, a local OpenAI-compatible model server such as Ollama, or Anthropic Claude. Using a hosted provider sends prompts to that provider; Atlas asks before sending a prompt. A local model can keep prompts on your computer.

## Ubuntu status

The supported way to try the current project is to run it from source. The Tauri desktop wrapper and `.deb` / AppImage bundle settings are present, but desktop packaging and its background services are unfinished. There is no working native installer release yet.

## Run from source on Ubuntu

### Requirements

- Ubuntu 24.04 or newer
- Git
- Rust stable and Cargo
- Node.js 22 or newer, with Corepack and pnpm 10
- Python 3.12 or newer
- A C compiler and linker (provided by `build-essential`)
- LibreOffice Writer if you want to import or export DOCX, ODT, or PDF documents

Install Ubuntu packages:

```bash
sudo apt update
sudo apt install -y build-essential curl git python3 python3-venv libreoffice-writer
```

Install Rust stable if it is not already installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup default stable
```

Install Node.js 22 using your preferred Node.js version manager or the official Node.js packages. Enable Corepack and activate the pnpm version used by this project:

```bash
corepack enable
corepack prepare pnpm@10.28.0 --activate
```

### Download and start Atlas

```bash
git clone https://github.com/techguychris2007/linux-productivity-suite.git
cd linux-productivity-suite
pnpm install
pnpm dev
```

The first run builds the Rust core and web interface. When startup finishes, the terminal prints a local URL. Open that URL in a browser on the same computer. Atlas binds its development services to `127.0.0.1`; keep the terminal open while using it. Press **Ctrl+C** in that terminal to stop Atlas.

### Set up Atlas AI and folders

- Open **Settings → Atlas AI** to choose a provider. For Gemini, create an API key in Google AI Studio and enter it in Settings. For a local provider, start your model server first, then configure its local API URL and model.
- Open **Settings → Folders** and choose which folders Atlas may access. Atlas cannot access folders you have not shared.
- Writer's DOCX, ODT, and PDF import/export features use LibreOffice Writer. Install it with `sudo apt install libreoffice-writer` if it is missing.

Provider settings are stored under Atlas's user data directory with owner-only file permissions. Hosted AI providers receive prompts you choose to send to them. Review each provider's privacy terms before use.

## Build and install the native desktop app

A native Tauri app is planned, with `.deb` and AppImage bundle targets. The current desktop entry point still needs its engine and core sidecar startup implemented and has not been compiled, so building or installing a package from this revision will not provide a complete desktop app. Use the source-run instructions above until a working Ubuntu release is published.

## Development checks

```bash
pnpm test:core      # Rust security core
pnpm test:engine    # Python engine
pnpm test:e2e       # Browser end-to-end checks
```

## Project layout

```
apps/shell/            React shell + Tauri desktop wrapper
packages/ui/           Design tokens and shared components
packages/shared-types/ Types shared by UI and engine API
crates/atlas-core/     Rust security core + atlas-core-host
services/engine/       Python Atlas Engine (AI orchestrator)
infrastructure/        Development scripts
 documentation/        Research, architecture, decisions, milestone reports
 tests/e2e/             End-to-end browser tests
```

See [the architecture recommendation](documentation/architecture/ARCHITECTURE_RECOMMENDATION.md) and the milestone reports in `documentation/development/` for more detail.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [the project decisions](documentation/development/DECISIONS.md).
