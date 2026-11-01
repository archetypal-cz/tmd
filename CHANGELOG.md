# Changelog

## 0.3.0 - unreleased (branch `cast`)

- `tmd audio`: radio play. `<work>/audio/cast.yaml` (roles → voices.yaml keys, `labels_map`,
  `labels: hide|read`, `turn_pause_ms`, per-role `fx`/`stability`) → plan `version: 2` with
  per-segment `role`, `voice`, `stability`, `fx`; `totals.roles`. Speaker from the `**NAME:**` label,
  hidden labels (kept in `plain`), mid-paragraph speaker/fx spans `at=… [until=…] speaker=… fx=…`,
  fx presets from `audio/effects.yaml` (shared + work). New: `compileRuns`, `parseCast`, `parseEffects`;
  CLI `--cast`, `--no-cast`, `--effects`. Without a cast the output is byte-identical to 0.2.1.

## 0.2.1 - 2026-11-01

- `tmd audio`: literal `[..]` in the work text become `(..)` in the engine text - ElevenLabs v3/v4
  would otherwise perform them as audio tags (found on Turing Test, translator note in brackets).

## 0.2.0 - 2026-11-01

- `tmd align` / `alignToTmd`: build TMD from an independently sourced original + existing translation
  (DP alignment 1-1/1-0/0-1/2-1/1-2, `ALIGN?` flags, hard projection gate, U+2060 guard for originals
  that would misclassify under §4, footnote pairing).
- `tmd stamp`: permanent paragraph IDs for translation-only files; refuses re-stamping.
- `tmd audio check|plan`: the `%%[audio …]%%` direction markers (Archetypal skill `audio-direction`)
  compiled into a TTS render plan - eleven_v4 tags, pauses, pronunciation with Czech inflection,
  work lexicon, sentence splitting, per-segment content hash as render-cache key.

