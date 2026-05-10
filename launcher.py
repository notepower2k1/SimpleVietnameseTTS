"""Simple TTS Launcher — starts server and opens browser."""
import os
import sys
import webbrowser
import threading
import time
from pathlib import Path

# Determine app root (where the exe/script lives)
if getattr(sys, 'frozen', False):
    APP_ROOT = Path(sys.executable).parent
else:
    APP_ROOT = Path(__file__).resolve().parent

# Set environment variables for resource paths
os.environ.setdefault("PIPER_DIR", str(APP_ROOT / "models" / "piper"))
os.environ.setdefault("FFMPEG_DIR", str(APP_ROOT / "ffmpeg" / "bin"))
os.environ.setdefault("F5_RESOURCE_DIR", str(APP_ROOT / "models" / "f5"))

# Ensure output and custom_dict dirs exist
(APP_ROOT / "outputs").mkdir(parents=True, exist_ok=True)
(APP_ROOT / "custom_dict").mkdir(parents=True, exist_ok=True)

# --- Backend selection ---
# Use backend_cpu if available (no GPU deps), else fallback to backend
BACKEND_DIR = APP_ROOT / "backend_cpu"
if not BACKEND_DIR.exists():
    BACKEND_DIR = APP_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

def open_browser():
    time.sleep(2)
    webbrowser.open("http://localhost:8000")

if __name__ == "__main__":
    threading.Thread(target=open_browser, daemon=True).start()
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
