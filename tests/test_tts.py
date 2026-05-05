import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# ─── config.py ───

class TestConfig:
    def test_default_paths(self):
        from config import _env_path
        p = _env_path("NONEXISTENT_VAR_XYZ", r"C:\default\path")
        assert p == Path(r"C:\default\path")

    def test_env_override(self):
        from config import _env_path
        os.environ["TEST_TTS_PATH"] = r"D:\custom\path"
        p = _env_path("TEST_TTS_PATH", r"C:\default")
        assert p == Path(r"D:\custom\path")
        del os.environ["TEST_TTS_PATH"]

    def test_output_dir_exists(self):
        from config import OUTPUT_DIR
        assert OUTPUT_DIR.exists()

# ─── tts_engine.py: TaskManager ───

@pytest.fixture
def task_mgr():
    from tts_engine import TaskManager
    return TaskManager()

class TestTaskManager:
    @pytest.mark.asyncio
    async def test_create_task(self, task_mgr):
        tid = await task_mgr.create(
            text="Hello world", voice_mode="preset", voice_id="banmai",
            speed=1.0, pitch=0.0, volume=0.0,
        )
        assert len(tid) == 12
        task = await task_mgr.get(tid)
        assert task is not None
        assert task["text"] == "Hello world"
        assert task["status"] == "pending"

    @pytest.mark.asyncio
    async def test_update_task(self, task_mgr):
        tid = await task_mgr.create(text="test", voice_mode="preset", voice_id="v1")
        await task_mgr.update(tid, status="processing", progress=50)
        task = await task_mgr.get(tid)
        assert task["status"] == "processing"
        assert task["progress"] == 50

    @pytest.mark.asyncio
    async def test_update_chunk(self, task_mgr):
        tid = await task_mgr.create(text="Hello. World.", voice_mode="preset", voice_id="v1")
        await task_mgr.update_chunk(tid, 0, status="processing")
        task = await task_mgr.get(tid)
        assert task["chunks"][0]["status"] == "processing"

    @pytest.mark.asyncio
    async def test_set_chunk_audio(self, task_mgr):
        tid = await task_mgr.create(text="Hello. World.", voice_mode="preset", voice_id="v1")
        await task_mgr.set_chunk_audio(tid, 0, "/path/audio.wav", duration=2.5)
        task = await task_mgr.get(tid)
        assert task["chunks"][0]["status"] == "done"
        assert task["chunks"][0]["audio_path"] == "/path/audio.wav"
        assert task["chunks"][0]["duration"] == 2.5

    @pytest.mark.asyncio
    async def test_set_chunk_error(self, task_mgr):
        tid = await task_mgr.create(text="Hello.", voice_mode="preset", voice_id="v1")
        await task_mgr.set_chunk_error(tid, 0, "Synth failed")
        task = await task_mgr.get(tid)
        assert task["chunks"][0]["status"] == "error"
        assert task["chunks"][0]["error"] == "Synth failed"

    @pytest.mark.asyncio
    async def test_recalc_progress(self, task_mgr):
        tid = await task_mgr.create(text="One. Two. Three.", voice_mode="preset", voice_id="v1")
        await task_mgr.set_chunk_audio(tid, 0, "/a.wav", 1.0)
        await task_mgr.recalc_progress(tid)
        task = await task_mgr.get(tid)
        assert task["progress"] >= 5

    @pytest.mark.asyncio
    async def test_reset(self, task_mgr):
        tid = await task_mgr.create(text="test", voice_mode="preset", voice_id="v1")
        assert await task_mgr.reset(tid) is True
        assert await task_mgr.get(tid) is None
        assert await task_mgr.reset("nonexistent") is False

    @pytest.mark.asyncio
    async def test_set_chunks(self, task_mgr):
        tid = await task_mgr.create(text="test", voice_mode="preset", voice_id="v1")
        new_chunks = [{"index": 0, "text": "new", "status": "pending", "audio_path": None, "error": None}]
        assert await task_mgr.set_chunks(tid, new_chunks) is True
        task = await task_mgr.get(tid)
        assert len(task["chunks"]) == 1
        assert task["chunks"][0]["text"] == "new"
        assert await task_mgr.set_chunks("nonexistent", []) is False

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, task_mgr):
        assert await task_mgr.get("fake_id") is None

# ─── tts_engine.py: chunk_text_sentences ───

class TestChunkText:
    def test_single_sentence(self):
        from tts_engine import chunk_text_sentences
        result = chunk_text_sentences("Hello world.")
        assert result == ["Hello world."]

    def test_multiple_sentences(self):
        from tts_engine import chunk_text_sentences
        result = chunk_text_sentences("First. Second! Third?")
        assert result == ["First.", "Second!", "Third?"]

    def test_paragraph_split(self):
        from tts_engine import chunk_text_sentences
        result = chunk_text_sentences("Para one.\n\nPara two.")
        assert result == ["Para one.", "Para two."]

    def test_empty_text(self):
        from tts_engine import chunk_text_sentences
        assert chunk_text_sentences("") == []

    def test_max_chars(self):
        from tts_engine import chunk_text_sentences
        result = chunk_text_sentences("A. B. C. D.", max_chars=6)
        assert all(len(c) <= 6 for c in result)

# ─── tts_engine.py: clean_text ───

class TestCleanText:
    def test_collapse_spaces(self):
        from tts_engine import clean_text
        assert clean_text("hello   world") == "hello world"

    def test_duplicate_punctuation(self):
        from tts_engine import clean_text
        assert clean_text("Wait???") == "Wait?"
        assert clean_text("Wow!!!") == "Wow!"

    def test_space_before_punct(self):
        from tts_engine import clean_text
        assert clean_text("Hello , world .") == "Hello, world."

    def test_missing_space_after_punct(self):
        from tts_engine import clean_text
        assert clean_text("Hello.World") == "Hello. World"

# ─── main.py: pause config ───

class TestPauseConfig:
    def test_merge_pause_config_defaults(self):
        from main import _merge_pause_config
        result = _merge_pause_config({})
        assert result["enabled"] is True
        assert "." in result["pauses"]
        assert "," in result["pauses"]

    def test_merge_pause_config_override(self):
        from main import _merge_pause_config
        result = _merge_pause_config({"enabled": False, "pauses": {".": 1.0}})
        assert result["enabled"] is False
        assert result["pauses"]["."] == 1.0
        assert result["pauses"][","] == 0.2

    def test_merge_pause_config_negative(self):
        from main import _merge_pause_config
        result = _merge_pause_config({"pauses": {".": -0.5}})
        assert result["pauses"]["."] == 0.0

# ─── main.py: voice_mode validation ───

class TestVoiceModeValidation:
    def test_valid_preset(self):
        from main import _validate_voice_mode
        assert _validate_voice_mode("preset") == "preset"

    def test_valid_custom(self):
        from main import _validate_voice_mode
        assert _validate_voice_mode("custom") == "custom"

    def test_invalid_mode(self):
        from main import _validate_voice_mode
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            _validate_voice_mode("invalid")
        assert exc.value.status_code == 400

# ─── main.py: normalize_with_pause_protection ───

class TestNormalizeWithPauseProtection:
    def test_preserves_pause_marker(self):
        from main import normalize_with_pause_protection
        with patch("main.normalize_vietnamese", side_effect=lambda x: x):
            result = normalize_with_pause_protection("Hello [1s] World")
            assert "[1s]" in result

    def test_preserves_float_pause(self):
        from main import normalize_with_pause_protection
        with patch("main.normalize_vietnamese", side_effect=lambda x: x):
            result = normalize_with_pause_protection("Hi [0.5s] there [2s] end")
            assert "[0.5s]" in result
            assert "[2s]" in result

    def test_normalizes_text_segments(self):
        from main import normalize_with_pause_protection
        with patch("main.normalize_vietnamese", side_effect=lambda x: x.upper()):
            result = normalize_with_pause_protection("hello [1s] world")
            assert "HELLO" in result
            assert "WORLD" in result
