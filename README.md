# Simple TTS — Vietnamese Text-to-Speech

> **100% Free · 100% Local · No API Keys · No Cloud · No Limits**

A self-hosted Vietnamese Text-to-Speech tool that runs entirely on your machine. No subscriptions, no usage quotas, no data sent to external servers. Your text and audio never leave your computer.

![Simple TTS UI](./screenshot.jpg)

## Why Local & Free?

| | Cloud TTS (Google, Azure, etc.) | Simple TTS |
|---|---|---|
| **Cost** | Pay per character / minute | **Free forever** |
| **Privacy** | Text sent to external servers | **100% local, offline** |
| **Limits** | Rate limits, quotas, API keys | **Unlimited, no keys needed** |
| **Internet** | Required | **Not required** |
| **Voice Cloning** | Expensive or unavailable | **Free with F5-TTS** |

## Features

- **Vietnamese-first** — Optimized for Vietnamese text normalization and pronunciation
- **Piper TTS** — Fast, lightweight neural TTS (CPU-friendly)
- **F5-TTS** — High-quality zero-shot voice cloning (GPU recommended)
- **Chunk-based generation** — Long text split into segments, generated sequentially with progress tracking
- **Custom dictionary** — Override pronunciation for acronyms and non-Vietnamese words
- **Pause control** — Adjustable silence after punctuation + custom `[Xs]` markers
- **History** — Auto-saved generation history with playback
- **Vietnamese normalization** — Built-in text normalization via `vietnormalizer`

## Hardware Recommendation

| Setup | Recommended Version | Notes |
|-------|---------------------|-------|
| **GPU (NVIDIA)** | `backend/` (GPU version) | F5-TTS voice cloning requires CUDA. Piper runs on CPU automatically. |
| **CPU only** | `backend_cpu/` (CPU version) | Piper TTS only. No voice cloning. Lightweight and fast. |
| **Mac / AMD** | `backend_cpu/` (CPU version) | F5-TTS currently optimized for NVIDIA GPUs. |

> **Recommendation:** Use the **GPU version** if you have an NVIDIA GPU with at least 4GB VRAM for voice cloning. Otherwise, the **CPU version** runs Piper TTS smoothly on any machine.

## Prerequisites

### 1. Python 3.11+

Download from [python.org](https://www.python.org/downloads/). Verify installation:
```bash
python --version
```

### 2. FFmpeg (Required)

FFmpeg is used for audio conversion (WAV ↔ MP3). **Must be installed separately.**

**Windows:**
1. Download FFmpeg from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (get the "essentials" build)
2. Extract to a folder (e.g., `D:\ffmpeg`)
3. Set the path in `config.py` or via environment variable:
   ```python
   FFMPEG_DIR = Path(r"D:\ffmpeg\bin")
   ```
4. Verify:
   ```cmd
   D:\ffmpeg\bin\ffmpeg.exe -version
   ```

**Linux:**
```bash
sudo apt install ffmpeg   # Debian/Ubuntu
sudo dnf install ffmpeg   # Fedora
```

**macOS:**
```bash
brew install ffmpeg
```

### 3. Model Files (Download Separately)

The project does not include model weights. Download and place them according to `config.py`:

| Folder | Contents | Download |
|--------|----------|----------|
| `PIPER_DIR` | Piper `.onnx` voice models + `.onnx.json` configs | [Piper voices](https://github.com/rhasspy/piper/blob/master/VOICES.md) |
| `F5_MODEL_DIR` | F5-TTS checkpoint (`model_last_repo_compatible_weights.pt`) + `vocab.txt` | [F5-TTS-Vietnamese](https://github.com/nguyenthienhy/F5-TTS-Vietnamese) |
| `F5_VOCODER_DIR` | Vocos vocoder (`vocos-mel-24khz`) | Bundled with F5-TTS |
| `F5_VOICES_DIR` | Reference audio (`.wav`/`.mp3`) + text (`.txt`) for cloned voices | Your own recordings |

### 4. GPU Version Only — CUDA

If using the GPU version with F5-TTS:
- NVIDIA GPU with **4GB+ VRAM**
- [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) 11.8+
- PyTorch with CUDA support:
  ```bash
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
  ```

## Quick Start

### GPU Version (Piper + F5-TTS)

```bash
cd backend
pip install -r requirements.txt
python main.py
```

Or double-click `run_api.bat`

### CPU-Only Version (Piper only)

```bash
cd backend_cpu
pip install -r requirements.txt
python main.py
```

Or double-click `run_api_cpu.bat`

Open http://localhost:8000 in your browser.

## Configuration

### Path Configuration

Edit `config.py` (or `backend_cpu/config.py`) to point to your installed resources:

```python
# Required — must exist
PIPER_DIR = Path(r"D:\TTS_Resource\piper")          # Piper .onnx models
FFMPEG_DIR = Path(r"D:\ffmpeg\bin")                  # ffmpeg.exe + ffprobe.exe

# GPU version only
F5_RESOURCE_DIR = Path(r"D:\TTS_Resource\f5")        # F5-TTS checkpoint + vocoder
```

Or set via environment variables:
```bash
set PIPER_DIR=D:\TTS_Resource\piper
set FFMPEG_DIR=D:\ffmpeg\bin
```

### Verify FFmpeg

Before running, make sure ffmpeg is accessible:
```bash
python -c "from pydub import AudioSegment; AudioSegment.from_wav('/dev/null')" 2>&1 | grep -i ffmpeg
```

If you see a warning about ffmpeg not found, update `FFMPEG_DIR` in `config.py`.

### Network Access

By default the server binds to `0.0.0.0` — accessible from your local network.

To restrict to localhost only, change `host="0.0.0.0"` to `host="127.0.0.1"` in `main.py` and `run_api.bat`.

To allow LAN access on Windows, open the firewall port:
```cmd
netsh advfirewall firewall add rule name="TTS API Port 8000" dir=in action=allow protocol=TCP localport=8000
```

Others on your Wi-Fi can then access via `http://<your-ip>:8000`

## Project Structure

```
TTS/
├── backend/              # GPU version (Piper + F5-TTS)
│   ├── main.py           # FastAPI endpoints
│   ├── tts_engine.py     # PiperEngine, F5Engine, TaskManager
│   ├── config.py         # Path configuration
│   ├── requirements.txt  # Dependencies
│   ├── custom_dict/      # User dictionaries
│   ├── outputs/          # Generated audio files
│   └── f5_tts/           # Local F5-TTS copy
├── backend_cpu/          # CPU-only version (Piper only)
│   ├── main.py
│   ├── tts_engine.py
│   ├── config.py
│   ├── requirements.txt
│   └── custom_dict/
├── frontend/
│   └── index.html        # Single-page UI
├── run_api.bat           # Launch GPU version
├── run_api_cpu.bat       # Launch CPU version
├── screenshot.png        # UI screenshot
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tts/voices` | List available voices |
| `POST` | `/tts/preview` | Generate short preview |
| `POST` | `/tts/generate` | Start full generation |
| `GET` | `/tts/status/{task_id}` | Check generation progress |
| `POST` | `/tts/merge` | Merge chunks into final audio |
| `GET` | `/tts/download_file` | Download audio/SRT |
| `POST` | `/tts/clone` | Clone a new voice (GPU only) |
| `GET/POST/DELETE` | `/tts/dict/acronyms` | Manage acronym dictionary |
| `GET/POST/DELETE` | `/tts/dict/words` | Manage word dictionary |
| `GET/POST` | `/tts/pause_config` | Pause configuration |
| `GET/DELETE` | `/tts/history` | Generation history |

## Dependencies

### GPU Version
- `fastapi`, `uvicorn` — Web framework
- `pydub`, `ffmpeg` — Audio processing
- `torch`, `torchaudio` — PyTorch (GPU)
- `f5-tts` — Voice cloning model
- `piper-tts`, `onnxruntime` — Fast TTS
- `librosa`, `numpy` — Audio effects (pitch shift)
- `vietnormalizer` — Vietnamese text normalization
- `omegaconf` — Config management

### CPU Version
- `fastapi`, `uvicorn`
- `pydub`, `ffmpeg`
- `piper-tts`, `onnxruntime`
- `vietnormalizer`
- `numpy`

## License

Apache License 2.0. See [LICENSE](./LICENSE).

## References

This project builds on and references the following open-source projects:

- [F5-TTS-Vietnamese](https://github.com/nguyenthienhy/F5-TTS-Vietnamese) — Vietnamese voice cloning
- [vietnormalizer](https://github.com/nghimestudio/vietnormalizer) — Vietnamese text normalization
- [piper](https://github.com/rhasspy/piper) — Local text-to-speech synthesis
