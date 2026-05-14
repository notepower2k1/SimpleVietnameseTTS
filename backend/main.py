import os
import re
import asyncio
import time
import io
import shutil
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydub import AudioSegment
import sys

import json

from config import OUTPUT_DIR, PIPER_DIR, F5_VOICES_DIR, F5_RESOURCE_DIR, OMNIVOICE_MODEL_DIR, MAX_TEXT_LENGTH

# ─── Resource Download ───

import aiohttp
import aiofiles
from huggingface_hub import HfApi

_hf_api = HfApi()
_dl_state = {}  # resource_id -> {status, progress, current_file, error}
_dl_lock = asyncio.Lock()
HF_URL = "https://huggingface.co/{repo}/resolve/main/{path}"

# Piper voices list
_PIPER_VOICES = [
    "banmai", "chieuthanh", "cuc", "duyoryx3175", "lacphi",
    "maiphuong", "manhdung", "minhkhang", "minhquang",
    "ngochuyen", "ngochuyennew", "phuongtrang", "taian2",
    "vi_VN-vais1000-medium",
]

_RESOURCE_DEFS = [
    {
        "id": "piper",
        "label": "Piper Voices (Low · CPU)",
        "desc": f"{len(_PIPER_VOICES)} Vietnamese voices + configs",
        "repo_id": "Hacht/CapCapResource",
        "files": ["piper/voices.json"] + [f"piper/{v}{e}" for v in _PIPER_VOICES for e in [".onnx", ".onnx.json"]],
        "local_dir": str(PIPER_DIR),
    },
    {
        "id": "f5",
        "label": "F5-TTS Model (Medium · GPU)",
        "desc": "Checkpoint + vocab + Vocos vocoder",
        "repo_id": "Hacht/CapCapResource",
        "files": [
            "model_last_repo_compatible_weights.pt",
            "vocab.txt",
            "checkpoints/vocos-mel-24khz/pytorch_model.bin",
            "checkpoints/vocos-mel-24khz/config.yaml",
        ],
        "local_dir": str(F5_RESOURCE_DIR),
    },
    {
        "id": "f5_voices",
        "label": "F5 Voice References",
        "desc": "Sample voices for cloning demo",
        "repo_id": "Hacht/CapCapResource",
        "files": [f"f5_voice/{f}" for f in [
            "ai_hanh.mp3", "foxy.mp3", "lan.wav", "liam.mp3", "mai.mp3",
            "ngan_le.mp3", "ngan_nguyen.mp3", "nhat.mp3", "nhu.mp3",
            "nhung.mp3", "ninh_don.mp3", "phuong.mp3", "quynh_anh.mp3",
            "tham.mp3", "trieu_duong.mp3", "trung_caha.mp3", "tung.mp3",
        ]] + ["f5_voice/voices.json"],
        "local_dir": str(F5_VOICES_DIR),
    },
    {
        "id": "omnivoice",
        "label": "OmniVoice Model (High · GPU)",
        "desc": "Model weights + tokenizer (~2.3GB)",
        "repo_id": "Hacht/omnivoice-vietnamese",
        "files": [
            "model.safetensors",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "chat_template.jinja",
            "train_config.json",
        ],
        "local_dir": str(OMNIVOICE_MODEL_DIR),
    },
]

async def _get_file_sizes(repo_id: str, paths: list[str]) -> dict[str, int]:
    """Get file sizes from HuggingFace API."""
    loop = asyncio.get_running_loop()
    def _fetch():
        try:
            infos = _hf_api.get_paths_info(repo_id, paths)
            return {i.path: i.size for i in infos if i}
        except Exception:
            return {}
    return await loop.run_in_executor(None, _fetch)

async def _build_catalog():
    """Build resource catalog with live sizes and download status."""
    def _local_path(local_dir: Path, repo_path: str) -> Path:
        parts = Path(repo_path).parts
        if parts[0] in ("piper", "f5_voice"):
            return local_dir / Path(*parts[1:])
        return local_dir / Path(repo_path)

    result = []
    for rdef in _RESOURCE_DEFS:
        rid = rdef["id"]
        sizes = await _get_file_sizes(rdef["repo_id"], rdef["files"])
        total_size = sum(sizes.values())
        size_mb = total_size / (1024 * 1024)

        local_dir = Path(rdef["local_dir"])
        existing = []
        missing = []
        for fp in rdef["files"]:
            target = _local_path(local_dir, fp)
            if target.exists():
                existing.append(fp)
            else:
                missing.append(fp)

        async with _dl_lock:
            dl_info = _dl_state.get(rid, {"status": "none", "progress": 0, "current_file": "", "error": ""})

        result.append({
            "id": rid,
            "label": rdef["label"],
            "desc": rdef["desc"],
            "total_files": len(rdef["files"]),
            "existing_files": len(existing),
            "total_size_mb": round(size_mb, 1),
            "downloaded": len(missing) == 0,
            "status": dl_info["status"],
            "progress": dl_info["progress"],
            "current_file": dl_info["current_file"],
            "error": dl_info.get("error", ""),
        })
    return result

async def _download_resource(rid: str):
    """Background task: download all files for a resource."""
    def _local_path(local_dir: Path, repo_path: str) -> Path:
        parts = Path(repo_path).parts
        if parts[0] in ("piper", "f5_voice"):
            return local_dir / Path(*parts[1:])
        return local_dir / Path(repo_path)

    rdef = next((r for r in _RESOURCE_DEFS if r["id"] == rid), None)
    if not rdef:
        return

    local_dir = Path(rdef["local_dir"])
    repo_id = rdef["repo_id"]
    files = rdef["files"]

    # Get sizes for progress calculation
    sizes = await _get_file_sizes(repo_id, files)
    total_bytes = sum(sizes.values())
    downloaded_bytes = 0

    # Count already-downloaded bytes
    for fp in files:
        target = _local_path(local_dir, fp)
        if target.exists():
            downloaded_bytes += sizes.get(fp, 0)

    async with _dl_lock:
        _dl_state[rid] = {"status": "downloading", "progress": 0, "current_file": "", "error": ""}

    try:
        for fp in files:
            # Check if already downloaded
            target = _local_path(local_dir, fp)
            if target.exists():
                # Skip existing files (they might be from a previous download)
                if total_bytes > 0:
                    async with _dl_lock:
                        _dl_state[rid]["progress"] = int(downloaded_bytes * 100 / total_bytes)
                continue

            # Ensure parent dir exists
            target.parent.mkdir(parents=True, exist_ok=True)

            url = HF_URL.format(repo=repo_id, path=fp)
            async with _dl_lock:
                _dl_state[rid]["current_file"] = fp

            # Download with progress
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as resp:
                    resp.raise_for_status()
                    file_size = int(resp.headers.get("Content-Length", 0))
                    async with aiofiles.open(str(target), "wb") as f:
                        read_bytes = 0
                        while True:
                            chunk = await resp.content.read(65536)
                            if not chunk:
                                break
                            await f.write(chunk)
                            read_bytes += len(chunk)
                            if total_bytes > 0:
                                async with _dl_lock:
                                    _dl_state[rid]["progress"] = int((downloaded_bytes + read_bytes) * 100 / total_bytes)
                    downloaded_bytes += file_size or read_bytes

        async with _dl_lock:
            _dl_state[rid] = {"status": "done", "progress": 100, "current_file": "", "error": ""}

        # Refresh the engine voice lists
        if rid == "piper":
            piper_engine._meta = piper_engine._load_meta()
        elif rid in ("f5", "f5_voices"):
            f5_engine._audio_cache.clear()
        elif rid == "omnivoice":
            omnivoice_engine._loaded = False
            omnivoice_engine._voice_prompts.clear()

    except Exception as e:
        async with _dl_lock:
            _dl_state[rid] = {"status": "error", "progress": 0, "current_file": "", "error": str(e)}

from tts_engine import (
    PiperEngine, F5Engine, OmniVoiceEngine, TaskManager,
    chunk_text_sentences, merge_audio_segments,
    normalize_vietnamese, clean_text,
)

# ─── Synthesis ───

def _synthesize_one(piper_engine, f5_engine, omnivoice_engine, engine_type: str, text: str, voice_id: str, speed: float = 1.0, pitch: float = 0.0, volume: float = 0.0, normalize_audio: bool = True, cfg_strength: float = 2.0, steps: int = 32, sway: float = -1.0, num_step: int = 16):
    if engine_type == "high":
        audio = omnivoice_engine.synthesize(text, voice_id, speed=speed, cfg=cfg_strength, num_step=num_step)
        sr = 24000
    elif engine_type == "medium":
        audio = f5_engine.synthesize(text, voice_id, speed=speed, cfg=cfg_strength, nfe=steps, sway=sway)
        sr = 24000
    else:
        audio = piper_engine.synthesize(text, voice_id, speed=speed)
        sr = 22050

    if pitch != 0 and engine_type != "high":
        import librosa
        import numpy as np
        samples = np.array(audio.get_array_of_samples()).astype(np.float32) / 32768
        shifted = librosa.effects.pitch_shift(samples, sr=sr, n_steps=pitch)
        audio = AudioSegment((shifted * 32767).astype(np.int16).tobytes(),
            frame_rate=sr, sample_width=2, channels=1)
    if normalize_audio:
        target = -20
        if audio.dBFS != float('-inf'):
            change = target - audio.dBFS
            audio = audio.apply_gain(change)
    if volume != 0:
        audio = audio.apply_gain(volume)
    return audio


# ─── Pause config ───

PAUSE_FILE = Path(__file__).resolve().parent / "custom_dict" / "_pause.json"
PAUSE_DEFAULTS = {"enabled": True, "pauses": {".": 0.4, ",": 0.2, ";": 0.3, ":": 0.3, "?": 0.4, "!": 0.4, "linebreak": 0.6}}

def _merge_pause_config(cfg: dict) -> dict:
    enabled = bool(cfg.get("enabled", True))
    pauses = dict(PAUSE_DEFAULTS["pauses"])
    pauses.update(cfg.get("pauses", {}))
    valid_keys = {".", ",", ";", ":", "?", "!", "linebreak"}
    validated_pauses = {k: max(0, float(v)) for k, v in pauses.items() if k in valid_keys}
    return {"enabled": enabled, "pauses": validated_pauses}

def _load_pause_config() -> dict:
    if PAUSE_FILE.exists():
        try:
            cfg = json.loads(PAUSE_FILE.read_text(encoding="utf-8"))
            if isinstance(cfg, dict) and "pauses" in cfg:
                pauses = cfg["pauses"]
                for k, v in PAUSE_DEFAULTS["pauses"].items():
                    if k not in pauses:
                        pauses[k] = v
                return _merge_pause_config(cfg)
        except Exception:
            pass
    return dict(PAUSE_DEFAULTS)

def _save_pause_config(cfg: dict):
    PAUSE_FILE.parent.mkdir(parents=True, exist_ok=True)
    merged = _merge_pause_config(cfg)
    PAUSE_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")


# ─── Pause-aware synthesis ───

_PAUSE_CHARS = {".", ",", ";", ":", "?", "!"}

def _build_pause_re(pauses: dict):
    chars = "".join(re.escape(c) for c in pauses if c in _PAUSE_CHARS and pauses.get(c, 0) > 0)
    if not chars:
        return None
    return re.compile(f"([{chars}])")

CUSTOM_PAUSE_RE = re.compile(r'\[(\d+(?:\.\d+)?)\s*s\]', re.IGNORECASE)

def normalize_with_pause_protection(text: str) -> str:
    parts = CUSTOM_PAUSE_RE.split(text)
    result = []
    for i, part in enumerate(parts):
        if i % 2 == 0:
            if part.strip():
                result.append(normalize_vietnamese(part))
            else:
                result.append(part)
        else:
            result.append(f'[{part}s]')
    return ''.join(result)

def synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine, text: str, engine_type: str, voice_id: str, pause_cfg: dict, speed: float = 1.0, pitch: float = 0.0, volume: float = 0.0, normalize_audio: bool = True, skip_pause_split: bool = False, cfg_strength: float = 2.0, steps: int = 32, sway: float = -1.0, num_step: int = 16):
    def _synth(t, et, vid):
        return _synthesize_one(piper_engine, f5_engine, omnivoice_engine, et, t, vid, speed=speed, pitch=pitch, volume=volume, normalize_audio=normalize_audio, cfg_strength=cfg_strength, steps=steps, sway=sway, num_step=num_step)

    marker_parts = CUSTOM_PAUSE_RE.split(text)
    if skip_pause_split:
        # For GPU engines: no punctuation splitting — send full text in one call
        # Custom [Xs] pause markers are still handled between text segments
        result = AudioSegment.silent(duration=0)
        for mi, mp in enumerate(marker_parts):
            if mi % 2 == 0:
                t = mp.strip()
                if t:
                    result += _synth(t, engine_type, voice_id)
            else:
                try:
                    result += AudioSegment.silent(duration=int(float(mp) * 1000))
                except ValueError:
                    pass
        if len(result) == 0:
            return _synth(text.strip() or " ", engine_type, voice_id)
        return result

    # Original flow with punctuation splitting (for Piper / when pauses enabled)
    marker_parts = CUSTOM_PAUSE_RE.split(text)
    result = AudioSegment.silent(duration=0)
    for mi, mp in enumerate(marker_parts):
        if mi % 2 == 0:
            t = mp.strip()
            if not t:
                continue
            pauses = pause_cfg.get("pauses", {})
            pause_re = _build_pause_re(pauses) if pause_cfg.get("enabled", True) else None
            if not pause_re:
                result += _synth(t, engine_type, voice_id)
            else:
                parts = [p for p in pause_re.split(t) if p.strip()]
                if not parts:
                    result += _synth(t, engine_type, voice_id)
                else:
                    merged = []
                    for p in parts:
                        if p in pauses and merged and merged[-1] in pauses and merged[-1] == p:
                            continue
                        merged.append(p)
                    j = 0
                    while j < len(merged):
                        part = merged[j]
                        if part in pauses and pauses[part] > 0:
                            result += AudioSegment.silent(duration=int(pauses[part] * 1000))
                            j += 1
                            continue
                        if part.strip():
                            result += _synth(part, engine_type, voice_id)
                        j += 1
                        if j < len(merged) and merged[j] in pauses and pauses[merged[j]] > 0:
                            result += AudioSegment.silent(duration=int(pauses[merged[j]] * 1000))
                            j += 1
        else:
            try:
                result += AudioSegment.silent(duration=int(float(mp) * 1000))
            except ValueError:
                pass
    if len(result) == 0:
        return _synth(text.strip() or " ", engine_type, voice_id)
    return result


# ─── Engines ───

piper_engine = PiperEngine()
f5_engine = F5Engine()
omnivoice_engine = OmniVoiceEngine()
task_manager = TaskManager()
gpu_lock = asyncio.Lock()
_load_lock = asyncio.Lock()
_load_state = {
    "f5": {"loaded": False, "loading": False, "progress": 0, "message": "", "error": False},
    "omnivoice": {"loaded": False, "loading": False, "progress": 0, "message": "", "error": False},
}

_VALID_VOICE_MODES = {"low", "medium", "high"}

def _validate_voice_mode(mode: str) -> str:
    if mode not in _VALID_VOICE_MODES:
        raise HTTPException(400, f"Invalid quality: {mode}. Must be one of: low, medium, high")
    return mode


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Simple TTS", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def task_dir(task_id: str) -> Path:
    d = OUTPUT_DIR / task_id
    d.mkdir(parents=True, exist_ok=True)
    return d


class TTSRequest(BaseModel):
    text: str
    voice_mode: str = "low"
    voice_id: str = "banmai"
    output_format: str = "mp3"
    normalize: bool = False
    clean: bool = False
    normalize_audio: bool = True
    speed: float = 1.0
    pitch: float = 0.0
    volume: float = 0.0
    split_segments: bool = False
    cfg_strength: float = 2.0
    steps: int = 32
    sway: float = -1.0
    num_step: int = 16


class ChunkRegenRequest(BaseModel):
    task_id: str
    chunk_index: int
    text: str | None = None


class MergeRequest(BaseModel):
    task_id: str
    output_format: str = "mp3"


# ─── Voices ───

@app.get("/tts/voices")
async def list_voices():
    low = piper_engine.list_voices(include_rate=True)
    medium = f5_engine.list_voices(include_rate=True)
    high = omnivoice_engine.list_voices(include_rate=True)
    return {"low": low, "medium": medium, "high": high}


@app.get("/tts/voice_audio/{engine}/{voice_id}")
async def voice_audio(engine: str, voice_id: str):
    if engine == "piper":
        path = PIPER_DIR / f"{voice_id}.onnx"
        if not path.exists():
            raise HTTPException(404, "Voice not found")
        raise HTTPException(400, "Piper uses TTS preview")
    elif engine in ("f5", "omnivoice"):
        audio_path = None
        for ext in (".wav", ".mp3"):
            p = F5_VOICES_DIR / f"{voice_id}{ext}"
            if p.exists():
                audio_path = p
                break
        if not audio_path:
            raise HTTPException(404, "Audio not found")
        return FileResponse(str(audio_path), media_type="audio/mpeg" if audio_path.suffix == ".mp3" else "audio/wav")
    raise HTTPException(400, "Unknown engine")


# ─── Resource Download ───

@app.get("/tts/resource_catalog")
async def resource_catalog():
    return await _build_catalog()


class StartDownloadRequest(BaseModel):
    resource_id: str


@app.post("/tts/start_download")
async def start_download(req: StartDownloadRequest):
    rid = req.resource_id
    rdef = next((r for r in _RESOURCE_DEFS if r["id"] == rid), None)
    if not rdef:
        raise HTTPException(400, f"Unknown resource: {rid}")

    async with _dl_lock:
        if _dl_state.get(rid, {}).get("status") == "downloading":
            return {"status": "already_downloading"}

    asyncio.create_task(_download_resource(rid))
    return {"status": "started"}


@app.get("/tts/download_progress")
async def download_progress():
    async with _dl_lock:
        return dict(_dl_state)


# ─── Model Loading ───

@app.get("/tts/model_status")
async def model_status():
    _load_state["f5"]["loaded"] = f5_engine._loaded
    _load_state["omnivoice"]["loaded"] = omnivoice_engine._loaded
    return {
        "f5": dict(_load_state["f5"]),
        "omnivoice": dict(_load_state["omnivoice"]),
    }

class LoadModelRequest(BaseModel):
    model: str  # "f5" or "omnivoice"

@app.post("/tts/load_model")
async def load_model(req: LoadModelRequest):
    if req.model not in ("f5", "omnivoice"):
        raise HTTPException(400, "Model must be 'f5' or 'omnivoice'")

    engine = f5_engine if req.model == "f5" else omnivoice_engine
    state_key = "f5" if req.model == "f5" else "omnivoice"

    if engine._loaded:
        _load_state[state_key] = {"loaded": True, "loading": False, "progress": 100, "message": "Already loaded", "error": False}
        return {"status": "already_loaded"}

    async with _load_lock:
        if _load_state[state_key]["loading"]:
            return {"status": "already_loading"}

        _load_state[state_key] = {"loaded": False, "loading": True, "progress": 0, "message": "Starting...", "error": False}

    async def _load_in_background():
        def progress_cb(msg, pct):
            _load_state[state_key] = {"loaded": False, "loading": True, "progress": pct, "message": msg, "error": False}

        loop = asyncio.get_running_loop()
        try:
            async with gpu_lock:
                await loop.run_in_executor(None, engine.load, progress_cb)
            _load_state[state_key] = {"loaded": True, "loading": False, "progress": 100, "message": "Loaded", "error": False}
        except Exception as e:
            _load_state[state_key] = {"loaded": False, "loading": False, "progress": 0, "message": f"Error: {e}", "error": True}

    asyncio.create_task(_load_in_background())
    return {"status": "loading"}


# ─── Preview ───

@app.post("/tts/preview")
async def preview_tts(req: TTSRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Text is empty")

    engine_type = _validate_voice_mode(req.voice_mode)
    voice_id = req.voice_id or "banmai"

    if req.clean:
        text = clean_text(text)
    if req.normalize:
        text = normalize_with_pause_protection(text)

    preview_text = text[:100]
    sentences = chunk_text_sentences(preview_text)
    preview_text = sentences[0] if sentences else preview_text[:80]

    try:
        pause_cfg = _load_pause_config()
        loop = asyncio.get_running_loop()
        def _do():
            return synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine, preview_text, engine_type, voice_id, pause_cfg,
                speed=req.speed, pitch=req.pitch, volume=req.volume, cfg_strength=req.cfg_strength, steps=req.steps, sway=req.sway, num_step=req.num_step)
        if engine_type in ("medium", "high"):
            async with gpu_lock:
                audio = await loop.run_in_executor(None, _do)
        else:
            audio = await loop.run_in_executor(None, _do)
    except ValueError as e:
        raise HTTPException(404, str(e))

    preview_dir = OUTPUT_DIR / "_preview"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_filename = f"preview_{int(time.time())}.wav"
    preview_path = preview_dir / preview_filename
    audio.export(str(preview_path), format="wav")
    return {
        "audio_url": f"/tts/download_file?path=_preview/{preview_filename}",
        "duration": round(len(audio) / 1000, 2),
    }


# ─── Generate ───

@app.post("/tts/generate")
async def generate_tts(req: TTSRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Text is empty")
    if len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(400, f"Text exceeds {MAX_TEXT_LENGTH} characters")

    _validate_voice_mode(req.voice_mode)

    task_id = await task_manager.create(
        text=text,
        voice_mode=req.voice_mode,
        voice_id=req.voice_id,
        output_format=req.output_format or "mp3",
        normalize=req.normalize,
        clean=req.clean,
        normalize_audio=req.normalize_audio,
        speed=req.speed,
        pitch=req.pitch,
        volume=req.volume,
        split_segments=req.split_segments,
        cfg_strength=req.cfg_strength,
        steps=req.steps,
        sway=req.sway,
        num_step=req.num_step,
    )

    asyncio.create_task(_run_generation(task_id))
    return {"task_id": task_id}


async def _run_generation(task_id: str):
    task = await task_manager.get(task_id)
    if not task:
        return
    text = task["text"]
    voice_mode = task["voice_mode"]
    voice_id = task["voice_id"]
    engine_type = _validate_voice_mode(voice_mode)
    do_normalize = task.get("normalize")
    do_clean = task.get("clean")
    split_seg = task.get("split_segments", False)

    try:
        await task_manager.update(task_id, status="processing", progress=0, stage="splitting")
        if do_clean:
            text = clean_text(text)
        raw_chunks = chunk_text_sentences(text)
        if not raw_chunks:
            await task_manager.update(task_id, status="error", error="No text to process")
            return

        if split_seg:
            # Split mode: per-sentence chunks
            raw_paragraphs = re.split(r'\n\s*\n', text.strip())
            para_sentence_counts = []
            for p in raw_paragraphs:
                p = p.strip()
                if p:
                    sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', p) if s.strip()]
                    para_sentence_counts.append(len(sents))
            is_new_para = []
            for count in para_sentence_counts:
                for j in range(count):
                    is_new_para.append(j == 0)
            orig_texts = list(raw_chunks)
            gen_texts = list(raw_chunks)
            if do_normalize:
                gen_texts = [normalize_with_pause_protection(c) for c in orig_texts]
            chunks_data = []
            for i in range(len(orig_texts)):
                chunks_data.append({
                    "index": i, "text": orig_texts[i], "gen_text": gen_texts[i],
                    "new_paragraph": is_new_para[i] if i < len(is_new_para) else False,
                    "status": "pending", "audio_path": None, "error": None,
                })
        else:
            # Non-split mode: one chunk, full text
            gen_text = normalize_with_pause_protection(text) if do_normalize else text
            chunks_data = [{
                "index": 0, "text": text, "gen_text": gen_text,
                "new_paragraph": False, "status": "pending", "audio_path": None, "error": None,
            }]
            orig_texts = [text]
            gen_texts = [gen_text]

        await task_manager.set_chunks(task_id, chunks_data)

        await task_manager.update(task_id, status="processing", progress=5, stage="generating")
        loop = asyncio.get_running_loop()
        pause_cfg = _load_pause_config()
        spd = task.get("speed", 1.0)
        pit = task.get("pitch", 0.0)
        vol = task.get("volume", 0.0)
        norm_audio = task.get("normalize_audio", True)
        cfg_val = task.get("cfg_strength", 2.0)
        steps_val = task.get("steps", 32)
        sway_val = task.get("sway", -1.0)
        num_step_val = task.get("num_step", 16)

        if not split_seg:
            # Single-shot: whole text in one go (faster, less modular)
            t_synth = time.time()
            skip_ps = True
            gen_text = gen_texts[0]
            if engine_type == "medium":
                f5_engine._force_single = True
            def _do_full(t=gen_text, et=engine_type, vid=voice_id, pc=pause_cfg, s=spd, p=pit, v=vol, na=norm_audio, sps=skip_ps, cf=cfg_val, ns=steps_val, sw=sway_val, nms=num_step_val):
                return synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine, t, et, vid, pc, speed=s, pitch=p, volume=v, normalize_audio=na, skip_pause_split=sps, cfg_strength=cf, steps=ns, sway=sw, num_step=nms)
            try:
                if engine_type in ("medium", "high"):
                    async with gpu_lock:
                        seg = await loop.run_in_executor(None, _do_full)
                else:
                    seg = await loop.run_in_executor(None, _do_full)
            finally:
                if engine_type == "medium":
                    f5_engine._force_single = False
            chunk_path = task_dir(task_id) / "chunk_0.wav"
            seg.export(str(chunk_path), format="wav")
            chunk_dur = round(len(seg) / 1000, 3)
            print(f"[TTS] non-split synth total={time.time()-t_synth:.2f}s engine={engine_type} chars={len(text)} chunk_dur={chunk_dur}s")
            await task_manager.set_chunk_audio(task_id, 0, f"/tts/download_file?path={task_id}/chunk_0.wav", duration=chunk_dur)
            await task_manager.update(task_id, status="chunks_done", progress=85, stage="chunks_done")
        else:
            # Per-sentence chunking
            t_synth = time.time()
            if engine_type == "low":
                # Piper: parallel synthesis (CPU threads)
                from functools import partial
                def _synth_one(i):
                    chunk_gen_text = gen_texts[i]
                    lb_pause = pause_cfg.get("pauses", {}).get("linebreak", 0)
                    seg = synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine,
                        chunk_gen_text, engine_type, voice_id, pause_cfg,
                        speed=spd, pitch=pit, volume=vol, normalize_audio=norm_audio,
                        cfg_strength=cfg_val, steps=steps_val, sway=sway_val, num_step=num_step_val)
                    if i > 0 and chunks_data[i].get("new_paragraph") and lb_pause > 0:
                        seg = AudioSegment.silent(duration=int(lb_pause * 1000)) + seg
                    chunk_filename = f"chunk_{i}.wav"
                    chunk_path = task_dir(task_id) / chunk_filename
                    seg.export(str(chunk_path), format="wav")
                    return i, chunk_filename, round(len(seg) / 1000, 3)

                tasks = [loop.run_in_executor(None, _synth_one, i) for i in range(len(orig_texts))]
                for coro in asyncio.as_completed(tasks):
                    i, chunk_filename, chunk_dur = await coro
                    await task_manager.update_chunk(task_id, i, status="processing")
                    await task_manager.set_chunk_audio(task_id, i,
                        f"/tts/download_file?path={task_id}/{chunk_filename}", duration=chunk_dur)
                    await task_manager.recalc_progress(task_id)
            else:
                for i in range(len(orig_texts)):
                    await task_manager.update_chunk(task_id, i, status="processing")
                    await task_manager.recalc_progress(task_id)
                    chunk_gen_text = gen_texts[i]

                    def _do_synth(t=chunk_gen_text, et=engine_type, vid=voice_id, pc=pause_cfg, s=spd, p=pit, v=vol, na=norm_audio, cf=cfg_val, ns=steps_val, sw=sway_val, nms=num_step_val):
                        return synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine, t, et, vid, pc, speed=s, pitch=p, volume=v, normalize_audio=na, cfg_strength=cf, steps=ns, sway=sw, num_step=nms)

                    seg = await loop.run_in_executor(None, _do_synth)

                    lb_pause = pause_cfg.get("pauses", {}).get("linebreak", 0)
                    if i > 0 and chunks_data[i].get("new_paragraph") and lb_pause > 0:
                        seg = AudioSegment.silent(duration=int(lb_pause * 1000)) + seg

                    chunk_filename = f"chunk_{i}.wav"
                    chunk_path = task_dir(task_id) / chunk_filename
                    seg.export(str(chunk_path), format="wav")
                    chunk_dur = round(len(seg) / 1000, 3)
                    await task_manager.set_chunk_audio(task_id, i, f"/tts/download_file?path={task_id}/{chunk_filename}", duration=chunk_dur)
                    await task_manager.recalc_progress(task_id)

            print(f"[TTS] split synth total={time.time()-t_synth:.2f}s engine={engine_type} chunks={len(orig_texts)} chars={len(text)}")
            await task_manager.update(task_id, status="chunks_done", progress=85, stage="chunks_done")

    except Exception as e:
        td = task_dir(task_id)
        if td.exists():
            for f in list(td.iterdir()):
                if f.name.startswith("chunk_"):
                    f.unlink()
        await task_manager.update(task_id, status="error", error=str(e))


# ─── Status ───

@app.get("/tts/status/{task_id}")
async def get_status(task_id: str):
    task = await task_manager.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {
        "task_id": task["task_id"],
        "status": task["status"],
        "progress": task["progress"],
        "stage": task["stage"],
        "audio_url": task.get("audio_url"),
        "duration": task.get("duration"),
        "error": task.get("error"),
        "chunks": [
            {
                "index": c["index"],
                "text": c["text"],
                "gen_text": c.get("gen_text", c["text"]),
                "status": c["status"],
                "audio_url": c["audio_path"],
                "duration": c.get("duration", 0),
                "error": c.get("error"),
            }
            for c in task.get("chunks", [])
        ],
    }


# ─── Regenerate chunk ───

@app.post("/tts/regenerate_chunk")
async def regenerate_chunk(req: ChunkRegenRequest):
    task = await task_manager.get(req.task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    if req.chunk_index < 0 or req.chunk_index >= len(task["chunks"]):
        raise HTTPException(400, "Invalid chunk index")

    chunk = task["chunks"][req.chunk_index]
    engine_type = _validate_voice_mode(task["voice_mode"])
    chunk_text = req.text if req.text else chunk["text"]

    # Skip if text unchanged and audio already generated
    if not req.text and chunk["status"] == "done" and chunk["audio_path"]:
        return {"chunk_index": req.chunk_index, "status": "cached", "audio_url": chunk["audio_path"]}

    chunk_gen_text = chunk_text
    if task.get("normalize"):
        chunk_gen_text = normalize_with_pause_protection(chunk_text)
    voice_id = task["voice_id"]

    await task_manager.update_chunk(req.task_id, req.chunk_index, status="processing", text=chunk_text, gen_text=chunk_gen_text)

    try:
        pause_cfg = _load_pause_config()
        spd = task.get("speed", 1.0)
        pit = task.get("pitch", 0.0)
        vol = task.get("volume", 0.0)
        na = task.get("normalize_audio", True)
        cf = task.get("cfg_strength", 2.0)
        ns = task.get("steps", 32)
        sw = task.get("sway", -1.0)
        nms = task.get("num_step", 8)
        loop = asyncio.get_running_loop()
        def _do(et=engine_type, t=chunk_gen_text, vid=voice_id, pc=pause_cfg, s=spd, p=pit, v=vol, n_audio=na, cfgv=cf, nsv=ns, swv=sw, nmsv=nms):
            return synthesize_with_pauses(piper_engine, f5_engine, omnivoice_engine, t, et, vid, pc, speed=s, pitch=p, volume=v, normalize_audio=n_audio, cfg_strength=cfgv, steps=nsv, sway=swv, num_step=nmsv)
        if engine_type in ("medium", "high"):
            async with gpu_lock:
                seg = await loop.run_in_executor(None, _do)
        else:
            seg = await loop.run_in_executor(None, _do)

        chunk_filename = f"chunk_{req.chunk_index}.wav"
        chunk_path = task_dir(req.task_id) / chunk_filename
        seg.export(str(chunk_path), format="wav")
        chunk_dur = round(len(seg) / 1000, 3)
        await task_manager.set_chunk_audio(req.task_id, req.chunk_index, f"/tts/download_file?path={req.task_id}/{chunk_filename}", duration=chunk_dur)
        await task_manager.recalc_progress(req.task_id)

        return {"chunk_index": req.chunk_index, "status": "done", "audio_url": f"/tts/download_file?path={req.task_id}/{chunk_filename}"}
    except Exception as e:
        await task_manager.set_chunk_error(req.task_id, req.chunk_index, str(e))
        raise HTTPException(500, str(e))


# ─── Merge ───

@app.post("/tts/merge")
async def merge_chunks(req: MergeRequest):
    task = await task_manager.get(req.task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    chunks = task["chunks"]
    if not chunks:
        raise HTTPException(400, "No chunks to merge")

    for c in chunks:
        if c["status"] != "done":
            raise HTTPException(400, f"Chunk {c['index']} is not done yet")

    output_format = req.output_format or "mp3"
    loop = asyncio.get_running_loop()
    td = task_dir(req.task_id)
    total_dur = 0

    segments = []
    srt_lines = []
    for idx, c in enumerate(chunks):
        path = c["audio_path"].split("?path=")[-1]
        chunk_rel = path.split("/", 1)[-1] if "/" in path else path
        full_path = td / chunk_rel
        seg = await loop.run_in_executor(None, AudioSegment.from_file, str(full_path))

        # Quick wins: trim silence, fade edges
        def _post(segment):
            s = segment.strip_silence(silence_len=100, silence_thresh=-50)
            return s.fade_in(8).fade_out(12)
        seg = await loop.run_in_executor(None, _post, seg)
        segments.append(seg)
        chunk_dur = c.get("duration", round(len(seg) / 1000, 3))

        start_ms = int(total_dur * 1000)
        end_ms = int((total_dur + chunk_dur) * 1000)
        def _ms2srt(ms):
            h, rem = divmod(ms, 3600000)
            m, rem = divmod(rem, 60000)
            s, ms = divmod(rem, 1000)
            return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
        txt = c["text"].strip().replace("\n", " ")
        srt_lines.append(f"{idx + 1}")
        srt_lines.append(f"{_ms2srt(start_ms)} --> {_ms2srt(end_ms)}")
        srt_lines.append(txt)
        srt_lines.append("")
        total_dur += chunk_dur

    # Volume match: normalize each segment to average RMS
    if len(segments) > 1:
        avg_db = sum(s.dBFS for s in segments) / len(segments)
        segments = [s.apply_gain(avg_db - s.dBFS) for s in segments]

    merged = await loop.run_in_executor(None, merge_audio_segments, segments)

    # Light compressor: threshold=-20dB, ratio=2:1
    def _compress(m):
        return m.compress_dynamic_range(threshold=-20, ratio=2.0, attack=5, release=50)
    merged = await loop.run_in_executor(None, _compress, merged)

    output_filename = f"final.{output_format}"
    output_path = td / output_filename
    merged.export(str(output_path), format=output_format, bitrate="320k")

    srt_path = td / "final.srt"
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(srt_lines))

    duration = round(len(merged) / 1000, 2)

    await task_manager.update(
        req.task_id,
        status="done",
        progress=100,
        stage="done",
        audio_url=f"/tts/download_file?path={req.task_id}/{output_filename}",
        duration=duration,
        done_at=asyncio.get_running_loop().time(),
    )

    await _save_history(req.task_id)

    return {"audio_url": f"/tts/download_file?path={req.task_id}/{output_filename}", "duration": duration}


# ─── Download ───

@app.get("/tts/download_file")
async def download_file(path: str = Query(...), format: str = Query("mp3")):
    file_path = OUTPUT_DIR / path
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    target_fmt = format.lower()

    if target_fmt == "srt":
        task_id = path.split("/")[0]
        srt_path = OUTPUT_DIR / task_id / "final.srt"
        if not srt_path.exists():
            raise HTTPException(404, "SRT file not found")
        return FileResponse(str(srt_path), media_type="text/plain", headers={"Content-Disposition": f'attachment; filename="subtitles.srt"'})

    if target_fmt not in ("mp3", "wav"):
        target_fmt = "mp3"
    src_fmt = file_path.suffix.lstrip(".")
    if src_fmt == target_fmt:
        media_type = "audio/mpeg" if target_fmt == "mp3" else "audio/wav"
        return FileResponse(str(file_path), media_type=media_type, filename=f"tts_output.{target_fmt}")
    loop = asyncio.get_running_loop()
    audio = await loop.run_in_executor(None, AudioSegment.from_file, str(file_path))
    buf = io.BytesIO()
    export_kwargs = {"format": target_fmt}
    if target_fmt == "mp3":
        export_kwargs["bitrate"] = "320k"
    await loop.run_in_executor(None, lambda: audio.export(buf, **export_kwargs))
    buf.seek(0)
    media_type = "audio/mpeg" if target_fmt == "mp3" else "audio/wav"
    return Response(content=buf.read(), media_type=media_type, headers={"Content-Disposition": f'attachment; filename="tts_output.{target_fmt}"'})


# ─── Reset ───

@app.post("/tts/reset/{task_id}")
async def reset_task(task_id: str):
    task = await task_manager.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    td = task_dir(task_id)
    preserved = {}
    if td.exists():
        for name in ("final.mp3", "final.wav", "final.srt"):
            fp = td / name
            if fp.exists():
                preserved[name] = fp.read_bytes()
        for f in td.iterdir():
            if f.name.startswith("chunk_"):
                f.unlink()
    await task_manager.reset(task_id)
    return {"status": "reset", "preserved_files": list(preserved.keys())}


# ─── Clone voice (shared dir for F5 + OmniVoice) ───

UPLOAD_DIR = OUTPUT_DIR / "_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@app.post("/tts/clone")
async def clone_voice(voice_id: str = Form(...), ref_text: str = Form(...), ref_audio: UploadFile = File(...)):
    vid = voice_id.strip()
    if not vid:
        raise HTTPException(400, "Voice ID is required")
    if not ref_text.strip():
        raise HTTPException(400, "Reference text is required")

    ext = Path(ref_audio.filename).suffix if ref_audio.filename else ".wav"
    upload_path = UPLOAD_DIR / f"clone_{vid}{ext}"
    content = await ref_audio.read()
    with open(upload_path, "wb") as f:
        f.write(content)

    try:
        loop = asyncio.get_running_loop()
        # Save to shared directory — both F5 and OmniVoice read from here
        await loop.run_in_executor(None, f5_engine.clone_voice, str(upload_path), ref_text, vid)
        await loop.run_in_executor(None, omnivoice_engine.clone_voice, str(upload_path), ref_text, vid)
        return {"voice_id": vid, "status": "cloned"}
    except Exception as e:
        raise HTTPException(500, str(e))


# ─── Dictionary ───

CUSTOM_DICT_DIR = Path(__file__).resolve().parent / "custom_dict"
CUSTOM_DICT_DIR.mkdir(parents=True, exist_ok=True)

class DictEntry(BaseModel):
    key: str
    value: str


def _read_csv(filename: str) -> list[dict]:
    import csv
    path = CUSTOM_DICT_DIR / filename
    if not path.exists():
        return []
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _write_csv(filename: str, fieldnames: list[str], rows: list[dict]):
    import csv
    path = CUSTOM_DICT_DIR / filename
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def _get_csv_fieldnames(filename: str) -> list[str]:
    if filename == "acronyms.csv":
        return ["acronym", "transliteration"]
    return ["original", "transliteration"]


def _key_col(filename: str) -> str:
    return "acronym" if filename == "acronyms.csv" else "original"


async def _list_dict(filename: str) -> list[dict]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _read_csv, filename)


async def _save_dict(filename: str, key: str, value: str) -> list[dict]:
    loop = asyncio.get_running_loop()
    key_col = _key_col(filename)
    val_col = "transliteration"

    def _do():
        rows = _read_csv(filename)
        existing = None
        for r in rows:
            if r.get(key_col, "").strip().lower() == key.strip().lower():
                existing = r
                break
        if existing:
            existing[val_col] = value.strip()
        else:
            rows.append({key_col: key.strip(), val_col: value.strip()})
        _write_csv(filename, _get_csv_fieldnames(filename), rows)
        return rows

    return await loop.run_in_executor(None, _do)


async def _delete_dict(filename: str, key: str) -> list[dict]:
    loop = asyncio.get_running_loop()
    key_col = _key_col(filename)

    def _do():
        rows = _read_csv(filename)
        rows = [r for r in rows if r.get(key_col, "").strip().lower() != key.strip().lower()]
        _write_csv(filename, _get_csv_fieldnames(filename), rows)
        return rows

    return await loop.run_in_executor(None, _do)


@app.get("/tts/dict/acronyms")
async def get_acronyms():
    rows = await _list_dict("acronyms.csv")
    return {"entries": [{"key": r["acronym"], "value": r["transliteration"]} for r in rows]}


@app.post("/tts/dict/acronyms")
async def save_acronym(entry: DictEntry):
    rows = await _save_dict("acronyms.csv", entry.key, entry.value)
    return {"entries": [{"key": r["acronym"], "value": r["transliteration"]} for r in rows]}


@app.delete("/tts/dict/acronyms")
async def delete_acronym(key: str = Query(...)):
    rows = await _delete_dict("acronyms.csv", key)
    return {"entries": [{"key": r["acronym"], "value": r["transliteration"]} for r in rows]}


@app.get("/tts/dict/words")
async def get_words():
    rows = await _list_dict("non-vietnamese-words.csv")
    return {"entries": [{"key": r["original"], "value": r["transliteration"]} for r in rows]}


@app.post("/tts/dict/words")
async def save_word(entry: DictEntry):
    rows = await _save_dict("non-vietnamese-words.csv", entry.key, entry.value)
    return {"entries": [{"key": r["original"], "value": r["transliteration"]} for r in rows]}


@app.delete("/tts/dict/words")
async def delete_word(key: str = Query(...)):
    rows = await _delete_dict("non-vietnamese-words.csv", key)
    return {"entries": [{"key": r["original"], "value": r["transliteration"]} for r in rows]}


# ─── Pause config ───

class PauseConfigBody(BaseModel):
    config: dict


@app.get("/tts/pause_config")
async def get_pause_config():
    return _load_pause_config()


@app.post("/tts/pause_config")
async def save_pause_config(body: PauseConfigBody):
    _save_pause_config(body.config)
    return _load_pause_config()


# ─── History ───

HISTORY_FILE = Path(__file__).resolve().parent / "custom_dict" / "_history.json"
MAX_HISTORY = 30


async def _save_history(task_id: str):
    task = await task_manager.get(task_id)
    if not task or task.get("status") != "done":
        return
    import time as _time
    entry = {
        "id": task_id,
        "timestamp": _time.time(),
        "text": task["text"][:200],
        "voice_mode": task["voice_mode"],
        "voice_id": task["voice_id"],
        "audio_url": task.get("audio_url", ""),
        "duration": task.get("duration", 0),
        "output_format": task.get("output_format", "mp3"),
    }
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    history = []
    if HISTORY_FILE.exists():
        try:
            history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    history = [h for h in history if h.get("id") != task_id]
    history.insert(0, entry)
    history = history[:MAX_HISTORY]
    HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


@app.get("/tts/history")
async def get_history():
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


@app.delete("/tts/history/{history_id}")
async def delete_history(history_id: str):
    history = []
    if HISTORY_FILE.exists():
        try:
            history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    history = [h for h in history if h.get("id") != history_id]
    HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "deleted"}


@app.delete("/tts/history")
async def clear_history():
    import shutil
    # Delete all output directories
    for d in OUTPUT_DIR.iterdir():
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
    # Clear history file
    HISTORY_FILE.write_text("[]", encoding="utf-8")
    return {"status": "cleared"}


# ─── Frontend ───

# Serve frontend
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
FONTS_DIR = FRONTEND_DIR / "fonts"

app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")

@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


if __name__ == "__main__":
    try:
        import uvicorn
        reload_enabled = not getattr(sys, 'frozen', False)
        uvicorn.run(app, host="0.0.0.0", port=8000, reload=reload_enabled)
    except Exception as e:
        import traceback
        with open("error.log", "w") as f:
            traceback.print_exc(file=f)
        print(f"\nFATAL: {e}\nSee error.log for details.")
        os.system("pause")
