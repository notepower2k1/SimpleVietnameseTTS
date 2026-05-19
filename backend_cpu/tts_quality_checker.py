"""
TTS Segment Quality Checker

Evaluates generated audio segments and classifies them as done/warning/failed
based on duration, silence, volume, and clipping analysis.
"""

import numpy as np
from pydub import AudioSegment
from pydub.silence import detect_silence


def analyze_audio(audio_path: str = None, audio_segment=None) -> dict:
    if audio_segment is not None:
        audio = audio_segment
    else:
        audio = AudioSegment.from_file(audio_path)
    duration_sec = len(audio) / 1000.0

    samples = np.array(audio.get_array_of_samples())
    if audio.channels > 1:
        samples = samples.reshape(-1, audio.channels).mean(axis=1)

    max_val = float(np.iinfo(samples.dtype).max)
    samples_norm = samples.astype(np.float64) / max_val

    rms = np.sqrt(np.mean(samples_norm ** 2))
    rms_db = 20 * np.log10(max(rms, 1e-10))

    peak = np.max(np.abs(samples_norm))
    peak_db = 20 * np.log10(max(peak, 1e-10))

    clipped = np.sum(np.abs(samples_norm) >= 0.99)
    clipping_ratio = clipped / len(samples_norm) if len(samples_norm) > 0 else 0

    silence_ranges = detect_silence(audio, silence_thresh=-42, min_silence_len=50)
    total_silence_ms = sum(end - start for start, end in silence_ranges)
    silence_ratio = total_silence_ms / len(audio) if len(audio) > 0 else 0

    leading_silence_sec = 0.0
    trailing_silence_sec = 0.0
    if silence_ranges:
        if silence_ranges[0][0] == 0:
            leading_silence_sec = silence_ranges[0][1] / 1000.0
        if silence_ranges[-1][1] >= len(audio) - 50:
            trailing_silence_sec = (len(audio) - silence_ranges[-1][0]) / 1000.0

    return {
        "duration_sec": round(duration_sec, 3),
        "silence_ratio": round(silence_ratio, 4),
        "leading_silence_sec": round(leading_silence_sec, 3),
        "trailing_silence_sec": round(trailing_silence_sec, 3),
        "rms_db": round(rms_db, 2),
        "peak_db": round(peak_db, 2),
        "clipping_ratio": round(clipping_ratio, 6),
    }


def evaluate_segment_quality(text: str, audio_path: str = None, config: dict = None, audio_segment=None) -> dict:
    if config is None:
        config = _default_config()

    text_chars = len(text)
    text_words = len(text.split())

    estimated_sec = text_chars / config["duration"]["vietnamese_chars_per_second"]
    expected_min = estimated_sec * config["duration"]["min_ratio"]
    expected_max = estimated_sec * config["duration"]["max_ratio"]

    metrics = analyze_audio(audio_path, audio_segment=audio_segment)
    issues = []

    duration_sec = metrics["duration_sec"]
    silence_ratio = metrics["silence_ratio"]

    # --- Failed checks ---

    if duration_sec <= 0:
        return _failed("ZERO_DURATION", "Generated audio has zero duration", metrics)

    if silence_ratio >= config["silence"]["full_silence_ratio"] and duration_sec > 0:
        return _failed("FULL_SILENCE", "Generated audio is silent", metrics)

    if text_chars >= config["text"]["min_chars_for_short_audio_failed"] and duration_sec < config["text"]["extremely_short_audio_sec"]:
        return _failed("EXTREMELY_SHORT_AUDIO", "Generated audio is too short", metrics)

    # --- Warning checks ---

    if duration_sec < expected_min:
        issues.append(_issue("DURATION_TOO_SHORT", "warning", "Possible incomplete speech", {
            "duration_sec": duration_sec,
            "expected_min_sec": round(expected_min, 2),
        }))

    if duration_sec > expected_max:
        issues.append(_issue("DURATION_TOO_LONG", "warning", "Audio duration seems too long", {
            "duration_sec": duration_sec,
            "expected_max_sec": round(expected_max, 2),
        }))

    if silence_ratio >= config["silence"]["warning_silence_ratio"] and silence_ratio < config["silence"]["full_silence_ratio"]:
        issues.append(_issue("EXCESSIVE_SILENCE", "warning", "Silence detected", {
            "silence_ratio": silence_ratio,
        }))

    if metrics["leading_silence_sec"] >= config["silence"]["leading_silence_warning_sec"]:
        issues.append(_issue("LONG_LEADING_SILENCE", "warning", "Long silence at the beginning", {
            "leading_silence_sec": metrics["leading_silence_sec"],
        }))

    if metrics["trailing_silence_sec"] >= config["silence"]["trailing_silence_warning_sec"]:
        issues.append(_issue("LONG_TRAILING_SILENCE", "warning", "Long silence at the end", {
            "trailing_silence_sec": metrics["trailing_silence_sec"],
        }))

    if metrics["rms_db"] < config["volume"]["low_rms_db"] or metrics["peak_db"] < config["volume"]["low_peak_db"]:
        issues.append(_issue("LOW_VOLUME", "warning", "Audio volume is low", {
            "rms_db": metrics["rms_db"],
            "peak_db": metrics["peak_db"],
        }))

    if metrics["clipping_ratio"] >= config["clipping"]["warning_ratio"]:
        issues.append(_issue("CLIPPING_DETECTED", "warning", "Possible clipping detected", {
            "clipping_ratio": metrics["clipping_ratio"],
        }))

    if text_chars > config["text"]["long_segment_chars"]:
        issues.append(_issue("TEXT_TOO_LONG", "warning", "Segment text is too long", {
            "text_chars": text_chars,
        }))

    if issues:
        return {
            "status": "warning",
            "issues": issues,
            "metrics": metrics,
            "can_export": True,
            "should_recommend_retry": True,
        }

    return {
        "status": "done",
        "issues": [],
        "metrics": metrics,
        "can_export": True,
        "should_recommend_retry": False,
    }


def _failed(code: str, message: str, metrics: dict) -> dict:
    return {
        "status": "failed",
        "issues": [{
            "code": code,
            "severity": "failed",
            "message": message,
            "details": {},
        }],
        "metrics": metrics,
        "can_export": False,
        "should_recommend_retry": True,
    }


def _issue(code: str, severity: str, message: str, details: dict) -> dict:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "details": details,
    }


def _default_config() -> dict:
    return {
        "duration": {
            "vietnamese_words_per_second": 2.6,
            "vietnamese_chars_per_second": 13,
            "min_ratio": 0.55,
            "max_ratio": 1.8,
        },
        "silence": {
            "full_silence_ratio": 0.98,
            "warning_silence_ratio": 0.45,
            "leading_silence_warning_sec": 1.0,
            "trailing_silence_warning_sec": 1.5,
        },
        "volume": {
            "low_rms_db": -35,
            "low_peak_db": -18,
        },
        "clipping": {
            "sample_threshold": 0.99,
            "warning_ratio": 0.001,
        },
        "text": {
            "long_segment_chars": 500,
            "min_chars_for_short_audio_failed": 30,
            "extremely_short_audio_sec": 0.5,
        },
    }
