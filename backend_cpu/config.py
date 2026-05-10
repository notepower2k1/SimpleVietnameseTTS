from pathlib import Path
import os

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def _env_path(key: str, default: str) -> Path:
    return Path(os.environ.get(key, default))

_DEFAULT_RESOURCE = PROJECT_ROOT / "models"

PIPER_DIR = _env_path("PIPER_DIR", str(_DEFAULT_RESOURCE / "piper"))

# Paths for download feature (F5/OmniVoice resources — requires GPU to use)
F5_RESOURCE_DIR = _env_path("F5_RESOURCE_DIR", str(_DEFAULT_RESOURCE / "f5"))
F5_VOICES_DIR = F5_RESOURCE_DIR / "f5_voice"
OMNIVOICE_MODEL_DIR = F5_RESOURCE_DIR / "omnivoice"

FFMPEG_DIR = _env_path("FFMPEG_DIR", r"D:\CodingTime\ffmpeg-8.0.1-essentials_build\bin")

OUTPUT_DIR = PROJECT_ROOT / "backend_cpu" / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_TEXT_LENGTH = 10000
PIPER_SAMPLE_RATE = 22050
CROSS_FADE_MS = 50
