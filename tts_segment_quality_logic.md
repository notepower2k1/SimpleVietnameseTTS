# TTS Segment Quality Status Logic

## Purpose

This document defines the logic used to classify each generated TTS segment as:

- `done`
- `warning`
- `failed`

The goal is to help the UI and backend detect problematic audio segments after TTS generation.

This logic is intended for an AI agent or developer to implement in the TTS pipeline.

---

## Core Principle

A TTS segment should only be marked as `done` when:

```text
Audio exists
AND audio can be decoded
AND duration is reasonable
AND volume is acceptable
AND silence is not excessive
AND no serious generation error occurred
```

A segment should be marked as `warning` when:

```text
Audio was generated successfully
BUT the output may have quality issues
```

A segment should be marked as `failed` when:

```text
Audio is missing, corrupted, unusable, or generation crashed
```

---

# 1. Segment Status Definitions

## 1.1 Done

Use `done` when the audio is usable and no major issue is detected.

### Conditions

```text
audio_file_exists == true
audio_decode_success == true
duration > 0
duration is within expected range
silence_ratio is acceptable
volume is acceptable
clipping is not severe
generation_error == false
```

### UI Label

```text
Done
```

### UI Color

```text
Green
```

---

## 1.2 Warning

Use `warning` when audio exists and is playable, but may need user review.

### Meaning

```text
The segment generated audio successfully,
but one or more quality checks detected possible issues.
```

### User Actions

```text
[Play]
[Retry]
[Ignore]
[Edit Text]
```

---

## 1.3 Failed

Use `failed` when audio cannot be used.

### Meaning

```text
The segment failed generation,
or the generated audio is empty/corrupted/unusable.
```

### User Actions

```text
[Retry]
[Edit Text]
```

---

# 2. Required Audio Analysis Metrics

Each generated segment should be analyzed with the following metrics.

## 2.1 Required Input Data

```json
{
  "segment_id": 1,
  "text": "Input text of the segment",
  "audio_path": "path/to/audio.wav",
  "generation_error": null,
  "generation_time_ms": 1200
}
```

## 2.2 Required Output Data

```json
{
  "segment_id": 1,
  "status": "done | warning | failed",
  "issues": [],
  "metrics": {
    "text_chars": 120,
    "text_words": 25,
    "duration_sec": 8.4,
    "expected_duration_min_sec": 5.0,
    "expected_duration_max_sec": 14.0,
    "silence_ratio": 0.12,
    "leading_silence_sec": 0.2,
    "trailing_silence_sec": 0.3,
    "rms_db": -21.5,
    "peak_db": -2.1,
    "clipping_ratio": 0.0001
  }
}
```

---

# 3. Failed Logic

A segment must be marked as `failed` if any of the following conditions are true.

---

## 3.1 Generation Error

### Condition

```text
generation_error != null
```

### Examples

```text
CUDA out of memory
Inference timeout
Model crashed
Backend returned error
```

### Status

```text
failed
```

### Issue Code

```text
GENERATION_ERROR
```

### UI Message

```text
Audio generation failed
```

---

## 3.2 Missing Audio File

### Condition

```text
audio_path is null
OR audio_file_exists == false
```

### Status

```text
failed
```

### Issue Code

```text
MISSING_AUDIO
```

### UI Message

```text
No audio file generated
```

---

## 3.3 Empty Audio File

### Condition

```text
audio_file_size_bytes == 0
```

### Status

```text
failed
```

### Issue Code

```text
EMPTY_AUDIO_FILE
```

### UI Message

```text
Generated audio file is empty
```

---

## 3.4 Corrupted Audio

### Condition

```text
audio_decode_success == false
```

### Examples

```text
Invalid WAV header
Invalid MP3 file
FFmpeg decode error
Unsupported audio format
```

### Status

```text
failed
```

### Issue Code

```text
CORRUPTED_AUDIO
```

### UI Message

```text
Audio file is corrupted
```

---

## 3.5 Zero Duration

### Condition

```text
duration_sec <= 0
```

### Status

```text
failed
```

### Issue Code

```text
ZERO_DURATION
```

### UI Message

```text
Generated audio has zero duration
```

---

## 3.6 Full Silence

### Condition

```text
silence_ratio >= 0.98
AND duration_sec > 0
```

### Status

```text
failed
```

### Issue Code

```text
FULL_SILENCE
```

### UI Message

```text
Generated audio is silent
```

---

## 3.7 Extremely Short Audio

### Condition

```text
text_chars >= 30
AND duration_sec < 0.5
```

### Status

```text
failed
```

### Issue Code

```text
EXTREMELY_SHORT_AUDIO
```

### UI Message

```text
Generated audio is too short
```

---

# 4. Warning Logic

A segment should be marked as `warning` if audio is playable but any of the following conditions are true.

Warnings should not block export by default.

---

## 4.1 Duration Too Short

### Condition

```text
duration_sec < expected_duration_min_sec
```

### Recommended Expected Duration Formula

For Vietnamese TTS:

```text
estimated_seconds = text_words / 2.6
```

or:

```text
estimated_seconds = text_chars / 13
```

Use whichever is more stable in your system.

Recommended range:

```text
expected_duration_min_sec = estimated_seconds * 0.55
expected_duration_max_sec = estimated_seconds * 1.80
```

### Status

```text
warning
```

### Issue Code

```text
DURATION_TOO_SHORT
```

### UI Message

```text
Possible incomplete speech
```

---

## 4.2 Duration Too Long

### Condition

```text
duration_sec > expected_duration_max_sec
```

### Status

```text
warning
```

### Issue Code

```text
DURATION_TOO_LONG
```

### UI Message

```text
Audio duration seems too long
```

---

## 4.3 Excessive Silence

### Condition

```text
silence_ratio >= 0.45
AND silence_ratio < 0.98
```

### Status

```text
warning
```

### Issue Code

```text
EXCESSIVE_SILENCE
```

### UI Message

```text
Silence detected
```

---

## 4.4 Long Leading Silence

### Condition

```text
leading_silence_sec >= 1.0
```

### Status

```text
warning
```

### Issue Code

```text
LONG_LEADING_SILENCE
```

### UI Message

```text
Long silence at the beginning
```

---

## 4.5 Long Trailing Silence

### Condition

```text
trailing_silence_sec >= 1.5
```

### Status

```text
warning
```

### Issue Code

```text
LONG_TRAILING_SILENCE
```

### UI Message

```text
Long silence at the end
```

---

## 4.6 Low Volume

### Condition

```text
rms_db < -35
OR peak_db < -18
```

### Status

```text
warning
```

### Issue Code

```text
LOW_VOLUME
```

### UI Message

```text
Audio volume is low
```

---

## 4.7 Possible Clipping

### Condition

```text
clipping_ratio >= 0.001
```

Where:

```text
clipping_ratio = clipped_samples / total_samples
```

A clipped sample is a sample near maximum amplitude.

For normalized float audio:

```text
abs(sample) >= 0.99
```

### Status

```text
warning
```

### Issue Code

```text
CLIPPING_DETECTED
```

### UI Message

```text
Possible clipping detected
```

---

## 4.8 Text Too Long For One Segment

This warning can be checked before generation.

### Condition

```text
text_chars > 500
```

### Status

```text
warning
```

### Issue Code

```text
TEXT_TOO_LONG
```

### UI Message

```text
Segment text is too long
```

### Recommended Action

```text
Suggest splitting this segment
```

---

## 4.9 Suspicious Repetition

This is optional and can be implemented later.

### Condition

Use simple repeated phrase detection.

Example:

```text
same 2-5 word phrase repeated >= 3 times
```

### Status

```text
warning
```

### Issue Code

```text
REPETITION_DETECTED
```

### UI Message

```text
Possible repeated speech
```

---

# 5. Status Priority Rule

If multiple checks match, choose the highest priority status.

Priority order:

```text
failed > warning > done
```

Example:

```text
If audio is corrupted and duration is too short:
status = failed
```

Example:

```text
If audio is playable but has low volume and long silence:
status = warning
```

---

# 6. Recommended Issue Object

Each issue should follow this structure.

```json
{
  "code": "DURATION_TOO_SHORT",
  "severity": "warning",
  "message": "Possible incomplete speech",
  "details": {
    "duration_sec": 1.2,
    "expected_min_sec": 4.5
  }
}
```

---

# 7. Recommended Segment Status Object

```json
{
  "segment_id": 12,
  "status": "warning",
  "issues": [
    {
      "code": "DURATION_TOO_SHORT",
      "severity": "warning",
      "message": "Possible incomplete speech",
      "details": {
        "duration_sec": 1.2,
        "expected_min_sec": 4.5
      }
    }
  ],
  "can_export": true,
  "should_recommend_retry": true
}
```

---

# 8. Export Rules

## Done

```text
can_export = true
should_recommend_retry = false
```

## Warning

```text
can_export = true
should_recommend_retry = true
```

Warnings should not block export.

## Failed

```text
can_export = false
should_recommend_retry = true
```

Failed segments should block final merge/export unless user explicitly chooses to ignore them.

---

# 9. UI Mapping

## Done

```text
Label: Done
Color: Green
Icon: ✓
Actions: Play, Retry, Edit
```

## Processing

```text
Label: Processing
Color: Blue
Icon: Spinner
Actions: None or Cancel
```

## Warning

```text
Label: Warning
Color: Yellow
Icon: ⚠
Actions: Play, Retry, Ignore, Edit
```

## Failed

```text
Label: Failed
Color: Red
Icon: ❌
Actions: Retry, Edit
```

---

# 10. Pseudocode

```pseudo
function evaluateSegmentQuality(segment):
    issues = []

    if segment.generation_error exists:
        return failed("GENERATION_ERROR")

    if audio_path missing or file does not exist:
        return failed("MISSING_AUDIO")

    if audio_file_size_bytes == 0:
        return failed("EMPTY_AUDIO_FILE")

    audio = decode_audio(audio_path)
    if decode failed:
        return failed("CORRUPTED_AUDIO")

    metrics = analyze_audio(audio, segment.text)

    if metrics.duration_sec <= 0:
        return failed("ZERO_DURATION")

    if metrics.silence_ratio >= 0.98:
        return failed("FULL_SILENCE")

    if metrics.text_chars >= 30 and metrics.duration_sec < 0.5:
        return failed("EXTREMELY_SHORT_AUDIO")

    if metrics.duration_sec < metrics.expected_duration_min_sec:
        issues.add warning("DURATION_TOO_SHORT")

    if metrics.duration_sec > metrics.expected_duration_max_sec:
        issues.add warning("DURATION_TOO_LONG")

    if metrics.silence_ratio >= 0.45:
        issues.add warning("EXCESSIVE_SILENCE")

    if metrics.leading_silence_sec >= 1.0:
        issues.add warning("LONG_LEADING_SILENCE")

    if metrics.trailing_silence_sec >= 1.5:
        issues.add warning("LONG_TRAILING_SILENCE")

    if metrics.rms_db < -35 or metrics.peak_db < -18:
        issues.add warning("LOW_VOLUME")

    if metrics.clipping_ratio >= 0.001:
        issues.add warning("CLIPPING_DETECTED")

    if segment.text_chars > 500:
        issues.add warning("TEXT_TOO_LONG")

    if issues.length > 0:
        return {
            status: "warning",
            issues: issues,
            can_export: true,
            should_recommend_retry: true
        }

    return {
        status: "done",
        issues: [],
        can_export: true,
        should_recommend_retry: false
    }
```

---

# 11. Suggested Defaults

```json
{
  "duration": {
    "vietnamese_words_per_second": 2.6,
    "vietnamese_chars_per_second": 13,
    "min_ratio": 0.55,
    "max_ratio": 1.8
  },
  "silence": {
    "full_silence_ratio": 0.98,
    "warning_silence_ratio": 0.45,
    "leading_silence_warning_sec": 1.0,
    "trailing_silence_warning_sec": 1.5
  },
  "volume": {
    "low_rms_db": -35,
    "low_peak_db": -18
  },
  "clipping": {
    "sample_threshold": 0.99,
    "warning_ratio": 0.001
  },
  "text": {
    "long_segment_chars": 500,
    "min_chars_for_short_audio_failed": 30,
    "extremely_short_audio_sec": 0.5
  }
}
```

---

# 12. Notes For AI Agent

Implement this as a separate quality evaluation module.

Recommended file names:

```text
tts_quality_checker.py
tts_quality_checker.ts
segmentQuality.ts
audioQuality.ts
```

The module should expose one main function:

```text
evaluateSegmentQuality(segment, audioPath, config)
```

The function should return:

```text
status
issues
metrics
can_export
should_recommend_retry
```

Do not hardcode UI behavior inside this module.

This module should only return structured quality results.
