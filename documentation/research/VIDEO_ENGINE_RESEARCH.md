# Video Engine Research (Video Studio and Video Generator)

## 1. Editing engines

| Option | Facts | Assessment |
|---|---|---|
| **MLT framework** | [VERIFIED] LGPL-2.1 core (framework, mlt++); melt CLI GPL. Integrates FFmpeg, frei0r, LADSPA, SoX, Qt, SDL. Version 7.36.1 was released on 31 Dec 2025, and 7.38.0 is packaged. Designed for broadcast. https://mltframework.org/docs/copyrightpolicy/, https://github.com/mltframework/mlt | **Recommended engine.** It's the engine Kdenlive and Shotcut are built on. Its XML project format is documented, and multitrack tractors, transitions, filters and proxies are already solved. |
| Kdenlive | [VERIFIED] GPL-3.0-or-later; built on MLT, KDE and Qt; relies on FFmpeg, MLT and frei0r. | **Study** its timeline UX, proxy workflow and project model. Don't fork it: it's a Qt C++ app and can't be embedded in a React UI. |
| Shotcut | MLT-based, by Meltytech [UNVERIFIED licence: GPL-3] | **Study** for the minimal UI and export presets. |
| Blender VSE | GPL; very powerful, but a 3D application [UNVERIFIED details] | **Study only.** |
| DaVinci Resolve / Premiere Pro | Proprietary. Resolve has a free Linux version [UNVERIFIED] | **UX reference only** (colour pages, media pool, edit and trim modes). |
| GStreamer Editing Services (GES) | LGPL [UNVERIFIED] | **An alternative.** Its integration with WebKitGTK media is a plus, but it has fewer editors in production use. Keep it as plan B. |
| FFmpeg filtergraphs only | Simple, but [RECOMMENDATION] not suitable for interactive scrubbing of a multitrack timeline. | Use for **export, proxies, thumbnails, waveforms** and probing. |

## 2. Recommended Video Studio architecture
[RECOMMENDATION]
- **Project model:** Atlas keeps its own typed JSON timeline (tracks, clips, effects and keyframes), and **compiles it to MLT XML** for rendering. As a bonus, an "Export project to Kdenlive" feature becomes feasible because Kdenlive projects are MLT XML [UNVERIFIED compatibility depth].
- **Preview:** a Rust media service runs `libmlt` (dynamically linked, LGPL) or a `melt` subprocess. It renders preview frames at proxy resolution and streams them to the UI as a frame buffer or low-latency MJPEG/WebCodecs stream. **This is the largest technical risk in Video Studio**, so plan spike S-VID-1.
- **Proxies:** generate proxies on import with FFmpeg (e.g. 540p) and render final exports from the originals.
- **Export:** run `melt` with an avformat consumer as a background job, with progress events on the event bus.
- **AI tools** work on the JSON timeline: `add_clip`, `split_clip`, `trim`, `add_transition`, `add_subtitle_track`, `auto_rough_cut(transcript, instructions)`, and `export(preset)`. Transcription comes from a local Whisper-family model or an external API [EXTERNAL-AI].
- **GPU:** prefer VA-API, NVENC or NVDEC through FFmpeg for decoding and export where available. Detect them at runtime. [UNVERIFIED specifics per driver]

## 3. AI video generation

### 3.1 Backend: ComfyUI
- [VERIFIED] ComfyUI (Comfy-Org) is a GPL-3.0 node-graph engine with an HTTP API. It supports image, video, audio and 3D models, including Wan 2.1 and 2.2, LTX-Video, HunyuanVideo, Mochi and Stable Video Diffusion. It needs Python 3.10+ (3.12/3.13 recommended) and ships stable releases about weekly. Sources: https://github.com/Comfy-Org/ComfyUI, https://factory.ai/open-source-wikis/comfyui
- [VERIFIED] ComfyUI supports Wan 2.2 natively, with templates for text-to-video, image-to-video and first-to-last-frame workflows.
- [RECOMMENDATION] Run ComfyUI as a **separately installed, optional local service**. Atlas talks to it only through its HTTP/WebSocket API by submitting workflow JSON. Atlas ships its own versioned workflow templates. That avoids bundling GPL-3.0 code and several GB of PyTorch.

### 3.2 Models and hardware tiers

| Model | VRAM (evidence) | Licence | Atlas tier |
|---|---|---|---|
| Wan 2.2 TI2V-5B | ~8 GB fp8 [VERIFIED banodoco KB] | Apache-2.0 | **Tier 1 (8–12 GB GPU)** — default local model |
| Wan 2.1 T2V 1.3B | ~8 GB [VERIFIED] | Apache-2.0 | Tier 1, fast drafts |
| Wan 2.2 A14B (T2V/I2V) | The README states an **80 GB** minimum [VERIFIED computingforgeeks]. Community quantisation (FP8/GGUF) plus text-encoder offload fits 16–24 GB with some quality loss [VERIFIED novita, evetech]. | Apache-2.0 | **Tier 2 (24–32 GB GPU)** with quantisation |
| LTX-2.x | Up to 80 GB at full precision; quantised 720p on 24 GB [VERIFIED] | LTX Model License (revenue threshold) | Tier 2, optional; licence shown |
| HunyuanVideo 1.5 | 14 GB with FP8 + CPU offload [VERIFIED thundercompute] | Tencent Community License | Optional |
| Any model at full quality | 48–80 GB | — | **Tier 3: remote GPU** (self-hosted ComfyUI on a cloud GPU) or hosted APIs [PAID][EXTERNAL-AI] |

[LIMITATION] Machines without a supported NVIDIA or AMD GPU cannot generate video locally in practical time. Atlas must detect this and offer remote providers, or turn the feature off. It must not fail silently.

### 3.3 Provider abstraction
```ts
interface GenerationProvider {
  id: string; kind: "local-comfyui" | "remote-comfyui" | "hosted-api";
  capabilities(): Promise<Capability[]>; // t2v, i2v, t2i, tts, music
  estimate(job: JobSpec): Promise<{vramGB?: number; seconds?: number; costUSD?: number}>;
  submit(job: JobSpec): Promise<JobId>;
  events(id: JobId): AsyncIterable<JobEvent>; // progress, preview, done, error
  cancel(id: JobId): Promise<void>;
}
```
When a job finishes, the output is registered as an Atlas asset (with its model, licence, prompt and seed) and can be imported into Video Studio with one action.

## 4. Spikes
| Spike | Pass criteria |
|---|---|
| S-VID-1 MLT preview into the Tauri UI | Scrub a 3-track 1080p timeline (with proxies) at ≥24 fps preview on a mid-range laptop |
| S-VID-2 MLT XML export | Render a 60-second, 3-track timeline with a dissolve and a text overlay to H.264 MP4 that matches the preview |
| S-VID-3 ComfyUI Wan 2.2 5B job via API | Submit, stream progress, receive MP4 on an 8–12 GB GPU |
