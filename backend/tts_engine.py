import os
import json
import uuid
import re
import asyncio
import shutil
import wave
import io
import sys
from pathlib import Path
from typing import Optional

# Use local f5_tts copy (not system-installed)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import onnxruntime
import numpy as np
from pydub import AudioSegment

from piper import PiperVoice, PiperConfig
from piper.config import PhonemeType, SynthesisConfig

import torch
from f5_tts.infer.utils_infer import (
    infer_process,
    load_model,
    load_vocoder,
    preprocess_ref_audio_text,
    mel_spec_type,
    target_rms,
    cross_fade_duration,
    fix_duration,
    device as f5_device,
)
from f5_tts.model import CFM, DiT, UNetT
from omegaconf import OmegaConf
from importlib.resources import files

from config import (
    PIPER_DIR, F5_MODEL_DIR, F5_VOICES_DIR, F5_VOCODER_DIR,
    FFMPEG_DIR, OUTPUT_DIR, PIPER_SAMPLE_RATE, F5_SAMPLE_RATE,
    CROSS_FADE_MS,
)

AudioSegment.converter = str(FFMPEG_DIR / "ffmpeg.exe")
AudioSegment.ffprobe = str(FFMPEG_DIR / "ffprobe.exe")
os.environ["PATH"] = str(FFMPEG_DIR) + os.pathsep + os.environ.get("PATH", "")


_NORMALIZER_CACHE = {}

def normalize_vietnamese(text: str) -> str:
    try:
        from vietnormalizer import VietnameseNormalizer, normalizer as vn_mod
        from pathlib import Path
        import csv, shutil

        custom_dir = Path(__file__).resolve().parent / "custom_dict"
        combined_dir = custom_dir / "_combined"
        combined_dir.mkdir(parents=True, exist_ok=True)

        default_data = Path(vn_mod.__file__).parent / "data"

        cache_key = "combined"
        if cache_key not in _NORMALIZER_CACHE:
            # Build combined CSVs: defaults + custom overrides
            for name, key_col in [("acronyms.csv", "acronym"), ("non-vietnamese-words.csv", "original")]:
                target = combined_dir / name
                src = default_data / name

                # Read defaults
                entries = {}
                if src.exists():
                    for row in csv.DictReader(open(src, encoding="utf-8", newline="")):
                        k = (row.get(key_col) or "").strip().lower()
                        if k:
                            entries[k] = row

                # Overlay custom entries
                custom_file = custom_dir / name
                if custom_file.exists():
                    for row in csv.DictReader(open(custom_file, encoding="utf-8", newline="")):
                        k = (row.get(key_col) or "").strip().lower()
                        if k:
                            entries[k] = row

                # Write combined
                rows = list(entries.values())
                rows.sort(key=lambda r: len(r.get(key_col, "") or ""), reverse=True)
                fieldnames = list(rows[0].keys()) if rows else [key_col, "transliteration"]
                with open(target, "w", encoding="utf-8", newline="") as f:
                    w = csv.DictWriter(f, fieldnames=fieldnames)
                    w.writeheader()
                    w.writerows(rows)

            # Create normalizer pointing to combined dir
            normalizer = VietnameseNormalizer(data_dir=str(combined_dir))

            # Inject custom acronyms into non_vietnamese_map too
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
    text = re.sub(r' +', ' ', text)                              # collapse spaces
    text = re.sub(r'\b([A-Z]+)\b', lambda m: m.group(1).capitalize() if len(m.group(1)) > 2 else m.group(0), text)  # ALLCAPS -> Capitalize
    text = re.sub(r'([.,!?;:])\1+', r'\1', text)                 # ??? -> ?, !!! -> !
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)                 # space before punct
    text = re.sub(r'([.,!?;:])(?!\s)(?=[^\s])', r'\1 ', text)    # missing space after punct
    return text.strip()


def chunk_text_sentences(text: str, max_chars: int = 0) -> list[str]:
    # Split paragraphs first (blank lines), then sentences within each paragraph
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
            import json
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


class F5Engine:
    def __init__(self):
        self.model = None
        self.vocoder = None
        self._voices_dir = F5_VOICES_DIR
        self._loaded = False
        self._audio_cache: dict[str, dict] = {}

    def load(self):
        if self._loaded:
            return
        print("[F5] Loading model + vocoder on GPU...")
        cfg_path = files("f5_tts").joinpath("configs/F5TTS_Base.yaml")
        model_cfg = OmegaConf.load(cfg_path).model
        model_cls = globals()[model_cfg.backbone]
        self.vocoder = load_vocoder(
            vocoder_name="vocos",
            is_local=True,
            local_path=str(F5_VOCODER_DIR),
        )
        ckpt_path = str(F5_MODEL_DIR / "model_last_repo_compatible_weights.pt")
        vocab_path = str(F5_MODEL_DIR / "vocab.txt")
        self.model = load_model(
            model_cls,
            model_cfg.arch,
            ckpt_path,
            mel_spec_type="vocos",
            vocab_file=vocab_path,
        )
        print(f"[F5] Model loaded on {f5_device}")
        self._loaded = True
        self.preload()

    def preload(self):
        """Pre-compute cond_mel for all voices at startup."""
        import torch
        for v in self.list_voices():
            vid = v["id"]
            audio_file = self._find_audio(vid)
            ref_text = self._get_ref_text(vid)
            if audio_file and ref_text:
                try:
                    self._ensure_audio_cache(vid, audio_file, ref_text)
                    print(f"  [F5] Preloaded voice: {vid}")
                except Exception as e:
                    print(f"  [F5] Failed preload {vid}: {e}")

    def _load_meta(self) -> dict:
        meta = {}
        meta_file = F5_VOICES_DIR / "voices.json"
        if meta_file.exists():
            import json
            try:
                for entry in json.loads(meta_file.read_text(encoding="utf-8")):
                    vid = Path(entry.get("audio_path", "")).stem
                    meta[vid] = entry
            except Exception:
                pass
        return meta

    def list_voices(self, include_rate=False) -> list[dict]:
        meta = self._load_meta()
        voices = []
        seen = set()
        for pattern in ("*.wav", "*.mp3"):
            for f in sorted(self._voices_dir.glob(pattern)):
                vid = f.stem
                if vid in seen:
                    continue
                seen.add(vid)
                m = meta.get(vid, {})
                label = m.get("name", vid.replace("_", " ").title())
                v = {
                    "id": vid, "label": label, "engine": "f5",
                    "gender": m.get("gender", ""),
                    "description": m.get("description", ""),
                    "ref_text": (m.get("text_ref", "") or "")[:100],
                }
                if include_rate:
                    from f5_tts.infer.utils_infer import hop_length, target_sample_rate
                    cache = self._audio_cache.get(vid)
                    if cache:
                        ref_sec = cache["ref_audio_len"] * hop_length / target_sample_rate
                        v["rate"] = round(len(cache["ref_text"]) / ref_sec) if ref_sec > 0 else 18
                voices.append(v)
        return voices

    def _find_audio(self, voice_id: str) -> Path | None:
        for ext in (".wav", ".mp3"):
            p = self._voices_dir / f"{voice_id}{ext}"
            if p.exists():
                return p
        return None

    def _get_ref_text(self, voice_id: str) -> str:
        meta = self._load_meta()
        m = meta.get(voice_id, {})
        if m.get("text_ref"):
            return m["text_ref"].strip()
        txt_file = self._voices_dir / f"{voice_id}.txt"
        if txt_file.exists():
            return txt_file.read_text(encoding="utf-8").strip()
        return ""

    def synthesize(self, text: str, voice_id: str, speed: float = 1.0) -> AudioSegment:
        if not self._loaded:
            self.load()
        audio_file = self._find_audio(voice_id)
        ref_text = self._get_ref_text(voice_id)
        if not audio_file or not ref_text:
            raise ValueError(f"Voice '{voice_id}' not found in cached voices")

        # Use cached cond if available, otherwise load + cache
        cache = self._ensure_audio_cache(voice_id, audio_file, ref_text)

        # Split gen_text into batches matching cache max_chars
        from f5_tts.infer.utils_infer import chunk_text as f5_chunk
        gen_batches = f5_chunk(text, max_chars=cache["max_chars"])
        if len(gen_batches) == 0:
            gen_batches = [text]

        # Process each batch using cached audio + model.sample directly
        from f5_tts.infer.utils_infer import convert_char_to_pinyin, hop_length, target_sample_rate
        import torch

        final_wave = None
        for gen_text in gen_batches:
            local_speed = speed * (0.3 if len(gen_text.encode("utf-8")) < 10 else 1.0)

            text_list = [cache["ref_text"] + gen_text]
            final_text_list = convert_char_to_pinyin(text_list)

            ref_audio_len = cache["ref_audio_len"]
            ref_text_len = cache["ref_text_len"]
            gen_text_len = len(gen_text.encode("utf-8"))
            duration = ref_audio_len + int(ref_audio_len / ref_text_len * gen_text_len / local_speed)

            with torch.inference_mode():
                generated, _ = self.model.sample(
                    cond=cache["cond_mel"],
                    text=final_text_list,
                    duration=duration,
                    steps=64,
                    cfg_strength=1.7,
                    sway_sampling_coef=-1.0,
                )
                generated = generated.to(torch.float32)
                generated = generated[:, ref_audio_len:, :]
                generated = generated.permute(0, 2, 1)
                generated_wave = self.vocoder.decode(generated)

                wave_np = generated_wave.squeeze().cpu().numpy().astype(np.float32)

            if final_wave is None:
                final_wave = wave_np
            else:
                # Cross-fade
                from f5_tts.infer.utils_infer import cross_fade_duration as cf_dur
                cs = int(cf_dur * target_sample_rate)
                cs = min(cs, len(final_wave), len(wave_np))
                if cs > 0:
                    fade_out = np.linspace(1, 0, cs)
                    fade_in = np.linspace(0, 1, cs)
                    overlap = final_wave[-cs:] * fade_out + wave_np[:cs] * fade_in
                    final_wave = np.concatenate([final_wave[:-cs], overlap, wave_np[cs:]])
                else:
                    final_wave = np.concatenate([final_wave, wave_np])

        int16_audio = (final_wave * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(target_sample_rate)
            wf.writeframes(int16_audio.tobytes())
        buf.seek(0)
        return AudioSegment.from_wav(buf)

    def _ensure_audio_cache(self, voice_id: str, audio_file: Path, ref_text: str) -> dict:
        if voice_id in self._audio_cache:
            return self._audio_cache[voice_id]

        import torchaudio
        import torch
        from f5_tts.infer.utils_infer import (
            target_sample_rate, target_rms, hop_length,
        )

        audio, sr = torchaudio.load(str(audio_file))
        if audio.shape[0] > 1:
            audio = torch.mean(audio, dim=0, keepdim=True)
        rms = torch.sqrt(torch.mean(torch.square(audio)))
        if rms < target_rms:
            audio = audio * target_rms / rms
        if sr != target_sample_rate:
            audio = torchaudio.transforms.Resample(sr, target_sample_rate)(audio)
        audio = audio.to(f5_device)

        # Pre-compute mel spectrogram (the "speaker embedding") — skips mel_spec() per chunk
        with torch.inference_mode():
            cond_mel = self.model.mel_spec(audio)          # [1, 100, T_mel]
            cond_mel = cond_mel.permute(0, 2, 1)           # [1, T_mel, 100]

        ref_text = ref_text.strip()
        if not ref_text.endswith(". ") and not ref_text.endswith("。"):
            if ref_text.endswith("."):
                ref_text += " "
            else:
                ref_text += ". "

        ref_audio_len = audio.shape[-1] // hop_length
        ref_text_len = len(ref_text.encode("utf-8"))
        max_chars = int(ref_text_len / (audio.shape[-1] / target_sample_rate) * (22 - audio.shape[-1] / target_sample_rate))
        if max_chars < 50:
            max_chars = 135

        cache = {
            "cond_mel": cond_mel,
            "ref_text": ref_text,
            "ref_text_len": ref_text_len,
            "ref_audio_len": ref_audio_len,
            "max_chars": max_chars,
        }
        self._audio_cache[voice_id] = cache
        return cache

    def clone_voice(self, ref_audio_path: str, ref_text: str, voice_id: str):
        processed_audio, processed_text = preprocess_ref_audio_text(ref_audio_path, ref_text)
        target_audio = self._voices_dir / f"{voice_id}.wav"
        shutil.copy(processed_audio, target_audio)
        target_text = self._voices_dir / f"{voice_id}.txt"
        with open(target_text, "w", encoding="utf-8") as f:
            f.write(processed_text)
        return voice_id


class TaskManager:
    def __init__(self):
        self._tasks: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def create(self, text: str, voice_mode: str, voice_id: str, output_format: str = "mp3", normalize: bool = False, clean: bool = False, normalize_audio: bool = True, speed: float = 1.0, pitch: float = 0.0, volume: float = 0.0) -> str:
        task_id = uuid.uuid4().hex[:12]
        engine_type = voice_mode if voice_mode in ("preset", "custom") else "preset"
        raw_chunks = chunk_text_sentences(text)
        chunks = []
        for i, c in enumerate(raw_chunks):
            chunks.append({
                "index": i,
                "text": c,
                "status": "pending",
                "audio_path": None,
                "duration": 0,
                "error": None,
            })
        async with self._lock:
            self._tasks[task_id] = {
                "task_id": task_id,
                "text": text,
                "voice_mode": voice_mode,
                "voice_id": voice_id,
                "output_format": output_format,
                "normalize": normalize,
                "clean": clean,
                "normalize_audio": normalize_audio,
                "speed": speed,
                "pitch": pitch,
                "volume": volume,
                "chunks": chunks,
                "status": "pending",
                "progress": 0,
                "stage": "queued",
                "audio_url": None,
                "duration": None,
                "error": None,
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

    async def cleanup_old(self, max_age_sec: int = 600):
        now = asyncio.get_running_loop().time()
        async with self._lock:
            to_delete = []
            for tid, t in self._tasks.items():
                if t.get("done_at") and (now - t["done_at"]) > max_age_sec:
                    to_delete.append(tid)
            for tid in to_delete:
                del self._tasks[tid]

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
