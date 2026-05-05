import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def _env_path(key: str, default: str) -> Path:
    return Path(os.environ.get(key, default))

F5_RESOURCE_DIR = _env_path("F5_RESOURCE_DIR", r"D:\CodingTime\TTS_Resource\f5")
F5_MODEL_DIR = F5_RESOURCE_DIR
F5_VOICES_DIR = F5_RESOURCE_DIR / "f5_voice"
F5_VOCODER_DIR = F5_RESOURCE_DIR / "checkpoints" / "vocos-mel-24khz"

PIPER_DIR = _env_path("PIPER_DIR", r"D:\CodingTime\TTS_Resource\piper")

FFMPEG_DIR = _env_path("FFMPEG_DIR", r"D:\CodingTime\ffmpeg-8.0.1-essentials_build\bin")

OUTPUT_DIR = PROJECT_ROOT / "backend" / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MAX_TEXT_LENGTH = 5000
PIPER_SAMPLE_RATE = 22050
F5_SAMPLE_RATE = 24000
CROSS_FADE_MS = 50
