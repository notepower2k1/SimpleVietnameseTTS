@echo off
echo Starting TTS API server (CPU-only - Piper)...
cd /d "%~dp0backend_cpu"
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
