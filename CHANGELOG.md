# Changelog

## 0.2.0 - 2026-11-01

- `tmd align` / `alignToTmd`: build TMD from an independently sourced original + existing translation
  (DP alignment 1-1/1-0/0-1/2-1/1-2, `ALIGN?` flags, hard projection gate, U+2060 guard for originals
  that would misclassify under §4, footnote pairing).
- `tmd stamp`: permanent paragraph IDs for translation-only files; refuses re-stamping.
- `tmd audio check|plan`: the `%%[audio …]%%` direction markers (Archetypal skill `audio-direction`)
  compiled into a TTS render plan - eleven_v4 tags, pauses, pronunciation with Czech inflection,
  work lexicon, sentence splitting, per-segment content hash as render-cache key.

