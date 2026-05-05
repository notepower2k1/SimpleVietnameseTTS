from pathlib import Path
import os

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def _env_path(key: str, default: str) -> Path:
    return Path(os.environ.get(key, default))

PIPER_DIR = _env_path("PIPER_DIR", r"D:\CodingTime\TTS_Resource\piper")

FFMPEG_DIR = _env_path("FFMPEG_DIR", r"D:\CodingTime\ffmpeg-8.0.1-essentials_build\bin")

OUTPUT_DIR = PROJECT_ROOT / "backend_cpu" / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_TEXT_LENGTH = 5000
PIPER_SAMPLE_RATE = 22050
CROSS_FADE_MS = 50
