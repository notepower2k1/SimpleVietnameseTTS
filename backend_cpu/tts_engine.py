import os
import json
import uuid
import re
import asyncio
import csv
from pathlib import Path
from typing import Optional

import onnxruntime
import numpy as np
from pydub import AudioSegment

from piper import PiperVoice, PiperConfig
from piper.config import PhonemeType, SynthesisConfig

from config import PIPER_DIR, FFMPEG_DIR, OUTPUT_DIR, PIPER_SAMPLE_RATE, CROSS_FADE_MS

AudioSegment.converter = str(FFMPEG_DIR / "ffmpeg.exe")
AudioSegment.ffprobe = str(FFMPEG_DIR / "ffprobe.exe")
os.environ["PATH"] = str(FFMPEG_DIR) + os.pathsep + os.environ.get("PATH", "")


_NORMALIZER_CACHE = {}

def normalize_vietnamese(text: str) -> str:
    try:
        from vietnormalizer import VietnameseNormalizer, normalizer as vn_mod

        custom_dir = Path(__file__).resolve().parent / "custom_dict"
        combined_dir = custom_dir / "_combined"
        combined_dir.mkdir(parents=True, exist_ok=True)

        default_data = Path(vn_mod.__file__).parent / "data"

        cache_key = "combined"
        if cache_key not in _NORMALIZER_CACHE:
            for name, key_col in [("acronyms.csv", "acronym"), ("non-vietnamese-words.csv", "original")]:
                target = combined_dir / name
                src = default_data / name

                entries = {}
                if src.exists():
                    for row in csv.DictReader(open(src, encoding="utf-8", newline="")):
                        k = (row.get(key_col) or "").strip().lower()
                        if k:
                            entries[k] = row

                custom_file = custom_dir / name
                if custom_file.exists():
                    for row in csv.DictReader(open(custom_file, encoding="utf-8", newline="")):
                        k = (row.get(key_col) or "").strip().lower()
                        if k:
                            entries[k] = row

                rows = list(entries.values())
                rows.sort(key=lambda r: len(r.get(key_col, "") or ""), reverse=True)
                fieldnames = list(rows[0].keys()) if rows else [key_col, "transliteration"]
                with open(target, "w", encoding="utf-8", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=fieldnames)
                    w.writeheader()
                    w.writerows(rows)

            normalizer = VietnameseNormalizer(data_dir=str(combined_dir))

            custom_acro = custom_dir / "acronyms.csv"
            if custom_acro.exists():
                for row in csv.DictReader(open(custom_acro, encoding="utf-8", newline="")):
                    k = (row.get("acronym") or "").strip().lower()
                    v = (row.get("transliteration") or "").strip()
                    if k and v:
                        normalizer.non_vietnamese_map[k] = v
                normalizer.non_vietnamese_map = dict(
                    sorted(normalizer.non_vietnamese_map.items(), key=lambda x: len(x[0]), reverse=True)
                )
                normalizer._build_replacement_dict()

            _NORMALIZER_CACHE[cache_key] = normalizer
        else:
            normalizer = _NORMALIZER_CACHE[cache_key]

        return normalizer.normalize(text)

    except ImportError:
        return text


def clean_text(text: str) -> str:
    text = re.sub(r' +', ' ', text)
    text = re.sub(r'\b([A-Z]+)\b', lambda m: m.group(1).capitalize() if len(m.group(1)) > 2 else m.group(0), text)
    text = re.sub(r'([.,!?;:])\1+', r'\1', text)
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)
    text = re.sub(r'([.,!?;:])(?!\s)(?=[^\s])', r'\1 ', text)
    return text.strip()


def chunk_text_sentences(text: str, max_chars: int = 0) -> list[str]:
    paragraphs = re.split(r'\n\s*\n', text.strip())
    sentences = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        parts = re.split(r'(?<=[.!?])\s+', p)
        for s in parts:
            s = s.strip()
            if s:
                sentences.append(s)
    if not sentences:
        return []
    if max_chars <= 0:
        return sentences
    chunks = []
    current = ""
    for s in sentences:
        if len(current) + len(s) + 1 <= max_chars:
            current = (current + " " + s).strip()
        else:
            if current:
                chunks.append(current)
            current = s
    if current:
        chunks.append(current)
    return chunks


def merge_audio_segments(segments: list[AudioSegment]) -> AudioSegment:
    if not segments:
        return AudioSegment.silent(duration=0)
    result = segments[0]
    for seg in segments[1:]:
        result = result.append(seg, crossfade=CROSS_FADE_MS)
    return result


class PiperEngine:
    def __init__(self):
        self._voices: dict[str, PiperVoice] = {}
        self._models_dir = PIPER_DIR
        self._meta = self._load_meta()

    def _load_meta(self) -> dict:
        meta = {}
        meta_file = PIPER_DIR / "voices.json"
        if meta_file.exists():
            try:
                for entry in json.loads(meta_file.read_text(encoding="utf-8")):
                    vid = Path(entry.get("audio_path", "")).stem
                    meta[vid] = entry
            except Exception:
                pass
        return meta

    def list_voices(self, include_rate=False) -> list[dict]:
        voices = []
        for f in sorted(self._models_dir.glob("*.onnx")):
            voice_id = f.stem
            config_path = f.with_suffix(".onnx.json")
            if config_path.exists():
                m = self._meta.get(voice_id, {})
                label = m.get("name", voice_id.replace("_", " ").title())
                v = {"id": voice_id, "label": label, "engine": "piper", "gender": m.get("gender", ""), "description": m.get("description", "")}
                if include_rate:
                    v["rate"] = 18
                voices.append(v)
        return voices

    def _load_voice(self, voice_id: str) -> PiperVoice:
        if voice_id in self._voices:
            return self._voices[voice_id]
        onnx_path = self._models_dir / f"{voice_id}.onnx"
        json_path = self._models_dir / f"{voice_id}.onnx.json"
        if not onnx_path.exists() or not json_path.exists():
            raise ValueError(f"Voice '{voice_id}' not found")
        session = onnxruntime.InferenceSession(str(onnx_path))
        with open(json_path, encoding="utf-8") as f:
            piper_cfg = PiperConfig.from_dict(json.load(f))
        voice = PiperVoice(session, piper_cfg)
        self._voices[voice_id] = voice
        return voice

    def synthesize(self, text: str, voice_id: str, speed: float = 1.0) -> AudioSegment:
        voice = self._load_voice(voice_id)
        syn_cfg = SynthesisConfig(
            noise_scale=0.667,
            length_scale=max(0.5, min(2.0, speed)),
            noise_w_scale=0.8,
        )
        segments = []
        for chunk in voice.synthesize(text, syn_cfg):
            seg = AudioSegment(
                chunk.audio_int16_bytes,
                frame_rate=chunk.sample_rate,
                sample_width=chunk.sample_width,
                channels=chunk.sample_channels,
            )
            segments.append(seg)
        return merge_audio_segments(segments)


class TaskManager:
    def __init__(self):
        self._tasks: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def create(self, text: str, voice_mode: str, voice_id: str, output_format: str = "mp3", normalize: bool = False, clean: bool = False, normalize_audio: bool = True, speed: float = 1.0, pitch: float = 0.0, volume: float = 0.0) -> str:
        task_id = uuid.uuid4().hex[:12]
        raw_chunks = chunk_text_sentences(text)
        chunks = []
        for i, c in enumerate(raw_chunks):
            chunks.append({
                "index": i, "text": c, "status": "pending",
                "audio_path": None, "duration": 0, "error": None,
            })
        async with self._lock:
            self._tasks[task_id] = {
                "task_id": task_id, "text": text, "voice_mode": voice_mode,
                "voice_id": voice_id, "output_format": output_format,
                "normalize": normalize, "clean": clean, "normalize_audio": normalize_audio,
                "speed": speed, "pitch": pitch, "volume": volume,
                "chunks": chunks, "status": "pending", "progress": 0,
                "stage": "queued", "audio_url": None, "duration": None, "error": None,
            }
        return task_id

    async def update(self, task_id: str, **kwargs):
        async with self._lock:
            if task_id in self._tasks:
                self._tasks[task_id].update(kwargs)

    async def get(self, task_id: str) -> Optional[dict]:
        async with self._lock:
            return self._tasks.get(task_id)

    async def update_chunk(self, task_id: str, chunk_index: int, **kwargs):
        async with self._lock:
            task = self._tasks.get(task_id)
            if task and chunk_index < len(task["chunks"]):
                task["chunks"][chunk_index].update(kwargs)

    async def set_chunk_audio(self, task_id: str, chunk_index: int, audio_path: str, duration: float = 0):
        async with self._lock:
            task = self._tasks.get(task_id)
            if task and chunk_index < len(task["chunks"]):
                task["chunks"][chunk_index]["audio_path"] = audio_path
                task["chunks"][chunk_index]["duration"] = duration
                task["chunks"][chunk_index]["status"] = "done"

    async def set_chunk_audio_with_quality(self, task_id: str, chunk_index: int, audio_path: str, duration: float, quality: dict):
        async with self._lock:
            task = self._tasks.get(task_id)
            if task and chunk_index < len(task["chunks"]):
                chunk = task["chunks"][chunk_index]
                chunk["audio_path"] = audio_path
                chunk["duration"] = duration
                chunk["issues"] = quality["issues"]
                chunk["quality_metrics"] = quality["metrics"]
                chunk["can_export"] = quality["can_export"]
                chunk["should_recommend_retry"] = quality["should_recommend_retry"]
                if quality["status"] == "failed":
                    chunk["status"] = "error"
                    chunk["error"] = quality["issues"][0]["message"] if quality["issues"] else "Quality check failed"
                    chunk["warning"] = False
                elif quality["status"] == "warning":
                    chunk["status"] = "done"
                    chunk["warning"] = True
                else:
                    chunk["status"] = "done"
                    chunk["warning"] = False

    async def set_chunk_error(self, task_id: str, chunk_index: int, error: str):
        async with self._lock:
            task = self._tasks.get(task_id)
            if task and chunk_index < len(task["chunks"]):
                task["chunks"][chunk_index]["status"] = "error"
                task["chunks"][chunk_index]["error"] = error

    async def recalc_progress(self, task_id: str, extra_pct: int = 0):
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task or not task["chunks"]:
                return
            total = len(task["chunks"])
            done = sum(1 for c in task["chunks"] if c["status"] == "done")
            pct = 5 + int(80 * (done / total)) + extra_pct
            task["progress"] = min(pct, 100)

    async def reset(self, task_id: str) -> bool:
        async with self._lock:
            return self._tasks.pop(task_id, None) is not None

    async def set_chunks(self, task_id: str, chunks: list[dict]) -> bool:
        async with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task["chunks"] = chunks
                return True
            return False
