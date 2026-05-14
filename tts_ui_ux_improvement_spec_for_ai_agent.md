# TTS Studio UI/UX Improvement Specification

## Goal
Improve the current TTS Studio UI to production-grade quality while keeping the scope focused only on:

- Text-to-Speech generation
- Segment-based workflow
- Audio review
- Export audio

Do NOT evolve into:

- Timeline editor
- DAW
- Video editor
- Subtitle alignment tool

Core workflow:

```text
Input Text
→ Split Segments
→ Generate Audio
→ Review Segments
→ Retry Problematic Segments
→ Merge Final Audio
→ Export
```

---

# 1. Input UX Improvements

## Supported Input Types
Support multiple input sources:

- Manual text input
- Upload `.txt`
- Upload `.md`
- Drag & drop file upload
- Paste text

## Input Metadata
Display:

- Character count
- Word count
- Estimated audio duration
- Estimated segment count

Example:

```text
12,420 chars • Estimated audio: ~18 mins • 48 segments
```

## Input Actions
Required actions:

- Normalize text
- Split segments
- Clear input
- Save draft

---

# 2. Generation UX Improvements

## Queue Progress
Display real-time generation progress.

Required:

```text
Generating audio...
12 / 48 segments
██████████░░░░░░
ETA 01:32
```

## Current Active Segment
Highlight currently generating segment.

Visual requirements:

- Soft glow
- Spinner
- Processing animation

## Generation Controls
Required controls:

- Pause generation
- Cancel generation
- Resume generation

---

# 3. Segment UX Improvements

## Default Collapsed Segments
Segments should be collapsed by default.

Collapsed state example:

```text
[✓] Segment 12   00:08
Xin chào mọi người...
▶ Retry ✎
```

Expand only when editing.

## Compact Segment Actions
Replace large "Re-generate" button with compact actions.

Required actions:

- Play
- Retry
- Edit

Recommended layout:

```text
▶ Play   ↻ Retry   ✎ Edit
```

## Batch Actions
Add batch management controls.

Required:

```text
[Retry Failed]
[Retry Warning]
[Collapse All]
[Expand Failed]
```

## Segment Filtering
Add filtering system.

Required filters:

```text
[All]
[Done]
[Warning]
[Failed]
[Processing]
```

## Segment Retry Highlight
Clearly highlight segments requiring retry.

Visual requirements:

- Red border for failed
- Yellow border for warning
- Retry badge/icon
- Optional pulse animation

---

# 4. Status System

## Required Status Types
Each segment must display a clear status.

### Done

- Color: Green
- Icon: Checkmark

### Processing

- Color: Blue
- Icon: Spinner

### Warning

- Color: Yellow
- Icon: Warning triangle

### Failed

- Color: Red
- Icon: Error icon

---

# 5. Smart Warning System

## Warning Detection
Add automatic audio quality analysis.

Possible warnings:

```text
⚠ Duration mismatch
⚠ Silence detected
⚠ Volume too low
⚠ Clipping detected
⚠ Possible broken generation
```

## Severity Levels
Support:

### Minor Warning

```text
⚠ Slight duration mismatch
```

### Critical Warning

```text
❌ Possible broken generation
```

## Warning Actions
Required:

```text
[Play Warning Segments]
[Retry Warning]
```

Do NOT auto retry automatically.
User should decide whether retry is needed.

---

# 6. Final Audio Section Redesign

The final output section should feel premium and clearly separated from segment previews.

## Required Layout

```text
FINAL AUDIO
━━━━━━━━━━━━━━━━

Waveform

▶ 02:31

[Export MP3]
[Export WAV]
[Re-merge]
```

## Final Audio Metadata
Display:

- Total duration
- Total segments
- Voice used
- Output format

Example:

```text
Duration: 12:31
Segments: 48
Voice: Warm Female Narrator
```

## Export Options
Required:

- MP3
- WAV
- Multiple quality presets

Example:

```text
MP3 128k
MP3 320k
WAV
```

---

# 7. Visual Design Improvements

Current visual direction is good.
Maintain:

- Minimal
- Warm
- Clean
- Calm
- Readable

Avoid:

- Cyberpunk UI
- Overloaded AI dashboard style
- Heavy engineering UI

## Add Visual Depth
Required improvements:

- Soft shadows
- Hover states
- Selected states
- Active segment glow
- Smooth transitions
- Better visual hierarchy

## Spacing Consistency
Ensure:

- Consistent padding
- Consistent card spacing
- Consistent button height
- Consistent typography scale

---

# 8. Voice Selection UX

## Human-Friendly Voice Naming
Avoid technical naming.

Bad:

```text
Luu - OMNIVOICE
```

Good:

```text
Warm Female Narrator
Vietnamese • OminiVoice
```

## Voice Preview
Add instant voice preview.

Required action:

```text
▶ Preview Voice
```

## Voice Tags
Support descriptive tags.

Examples:

```text
Narration
Warm
Soft
Anime
Documentary
```

---

# 9. Empty States

Add proper empty states.

## No Segments

```text
No segments yet
Generate audio to begin
```

## No Warnings

```text
No problematic segments detected
```

---

# 10. Loading UX

Improve perceived responsiveness.

## Segment Loading
Show meaningful loading states.

Examples:

```text
Generating waveform...
Synthesizing voice...
```

## Skeleton Loading
Use skeleton loaders for:

- Segment cards
- Audio previews
- Final audio section

---

# 11. Project & Recovery UX

## Auto Save
Display autosave status.

Example:

```text
Auto saved 2 mins ago
```

## Recovery
Support restoring previous sessions.

Required:

```text
Restore previous generation
```

## History
Optional but recommended:

- Recent projects
- Export history
- Previous generations

---

# 12. Keyboard UX

Support keyboard shortcuts for power users.

Recommended shortcuts:

```text
Space → Play/Pause
R → Retry selected
Ctrl+Enter → Generate
```

---

# 13. Responsive UX

## Desktop Layout
Recommended:

```text
Left:
- Input
- Voice
- Settings

Center:
- Segment list

Bottom:
- Final audio section
```

## Mobile Layout
Recommended:

```text
Step 1: Input
Step 2: Voice
Step 3: Generate
Step 4: Review
Step 5: Export
```

Use:

- Drawer panels
- Bottom sheets
- Collapsible sections

Avoid fixed multi-column layouts on mobile.

---

# 14. UX Philosophy

This product should feel like:

```text
TTS Studio
```

NOT:

```text
AI demo page
```

The system should prioritize:

- Long-form TTS workflow
- Segment review workflow
- Retry workflow
- Production usability
- Simple but professional UX

Avoid feature creep into:

- Timeline editing
- DAW workflows
- Video editing
- Complex audio engineering interfaces

---

# Final UX Goal

Target UX quality:

- Production-grade TTS Studio
- Clean and minimal
- Efficient for long-form generation
- Friendly for normal users
- Scalable for large scripts
- Fast segment review workflow

Target score:

```text
UX: 9/10
Production usability: 9/10
Visual polish: 8.5+/10
```

