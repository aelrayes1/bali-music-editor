# Bali Music Editor

The analysis and effects engine behind an AI-assisted music-video editor. It turns local source
footage and a music track into deterministic, schema-validated analysis records, then builds
music-anchored visual effects on top of them. Creative decisions stay with a human: the engine
measures, proposes and verifies.

> **About this repository.** This is a public review snapshot of a private working repository.
> Two kinds of material were removed:
>
> - project-specific modules: the edit planner, the render-spec compiler, the critic/revision loop,
>   the delivery packager and the per-project finishing tools
> - all project data: media, analysis records, edit plans and approvals
>
> Everything here is the reusable engine, and it installs and tests on its own.
> There are no media files in this repository, and none are needed to run the tests.

## Capabilities in this snapshot

| Area | What it does | Code |
|---|---|---|
| **Media foundation** | Ingests configured source folders into a deterministic `media-manifest.json`. Uses ffprobe normalisation for rotation, display size, VFR detection and stream selection, content fingerprints, frame decoding and contact sheets. | `src/media`, `npm run ingest`, `npm run contact-sheet` |
| **Music analysis** | DSP features, tempo, beat and downbeat grid, meter, loudness, and structure (breaks, builds, drops, impacts, phrase boundaries, sections). Also detects vocal-band attacks without speech recognition. User-authored sync events and overrides are resolved into one event set, with diagnostics. | `src/music`, `npm run analyze-music` |
| **Vocal timing assist (optional)** | Runs a local whisper.cpp pass for word timing, then flags hallucinations, repetition loops and window edges. Resolves human-declared vocal occurrences (primary attack plus effect repeats). | `src/vocal`, `npm run transcribe-vocals` |
| **Footage analysis** | Objective per-shot metrics: shot boundaries, motion, sharpness, exposure and duplicates. Cached by content fingerprint and analyser version. | `src/footage`, `npm run analyze-footage` |
| **Semantic shots (macOS)** | On-device Apple Vision analysis of sampled frames (faces, people, body pose, image labels, saliency, text regions, feature prints), plus a cross-media index of novelty, duplicates and continuity candidates. No network, no downloaded models. | `src/semantic`, `native/vision-shots`, `npm run analyze-semantics` |
| **FX library** | A deterministic effect contract, anchored to music events and cut-safe. It includes the `CLEAN_TO_CHAOS` escalation preset and a subject-isolated temporal stutter: on-device person masks plus mask QC and eligibility gates. | `src/fx`, `native/subject-masks` |
| **Composition** | A 9:16 human-subject guardrail: dominant-subject tracking, bounded reframe proposals, and dead-band and lead-room rules. Crop options seeded from a human-chosen point. | `src/compose`, `src/render/crop-options.ts` |
| **Grade** | ASC CDL shot statistics with a restrained matching solver, and a highlight-selective bloom that generates a DaVinci Resolve DCTL plus a bit-matched offline twin. | `src/grade` |
| **Hardening** | Atomic writes, a disk-headroom policy, exact frame-timing, audio-sync, colour-tag and orientation checks, and an Edit Plan validator with coded issues. | `src/hardening` |
| **Style memory** | A preference engine with scoping rules: one project's taste never leaks into another, and general preferences need explicit statements or repeated evidence. | `src/style`, `npm run style` |
| **Renderer layer** | Remotion compositions that play resolved effects and plan clips, making no creative decisions. | `remotion/` |
| **Environment check** | `npm run doctor`: a read-only report of tools, codecs, disk and optional integrations. | `src/cli/doctor.ts` |

All records are validated with zod. `schemas/` holds the exported JSON Schemas; regenerate them
with `npm run schema:export`.

## Requirements

- macOS (Apple silicon tested). The Swift/Vision helpers are macOS-only; everything else is portable
  TypeScript.
- **Node.js ≥ 24.** The code runs as TypeScript directly via Node's type stripping, with no build step.
- **FFmpeg / ffprobe** on `PATH`, for media work and the acceptance tests.
- Optional:
  - Xcode command-line tools (`swiftc`), for `npm run build:vision` and `npm run build:subject-masks`
  - a local whisper.cpp build and model, for the vocal assist
  - DaVinci Resolve, for the DCTL / finishing path

## Setup

```bash
npm ci
npm run doctor                      # read-only environment report
cp config/sources.example.json config/sources.local.json
# edit config/sources.local.json: point each source root at your own footage / music folders
npm run ingest                      # -> analysis/media-manifest.json
```

Per-project configuration lives in `projects/<name>/` (not included). For example,
`projects/<name>/music-analysis.config.json` points the music CLIs at a local track and section
window. Media, analysis output, caches and renders are written to git-ignored folders
(`analysis/`, `cache/`, `projects/`, `renders/`).

To run the Remotion layer: `cd remotion && npm ci && npm run typecheck` (or `npm run studio`).

### Local configuration (placeholders, never committed)

| File | Purpose |
|---|---|
| `config/sources.local.json` | Your source roots (copy from `config/sources.example.json`) |
| `projects/<name>/music-analysis.config.json` | Track path and section window for the music CLIs |
| `style/bali/memory.json` + decision logs | Style memory used by `npm run style` (private; not included) |
| `.mcp.json` | Optional DaVinci Resolve MCP server wiring (machine-specific; not included) |
| `config/resolve-mcp/preferences.json` | Included. Resolve-MCP safety defaults (safe mode, confirmation tokens, audit logs); the log paths are relative placeholders |

## Tests

```bash
npm run typecheck          # tsc --noEmit
npm test                   # unit tests (pure, no media, no FFmpeg)
npm run test:acceptance    # synthetic acceptance tests (FFmpeg generates its own test media)
npm run test:fast          # all of the above
```

What the tests cover, and what they need:

- **Unit tests** (`tests/unit`): self-contained.
- **Acceptance tests** (`tests/acceptance`): generate synthetic media with FFmpeg into git-ignored
  temp folders.
- **`doctor.test.ts`**:
  - must run inside a git checkout (it asserts the doctor leaves the working tree unchanged)
  - checks that the committed Resolve-MCP safety preferences are on
  - the doctor itself reports BLOCKING when free disk is below the media floor in
    `config/resource-policy.json` (30 GiB); the test accepts that, it only checks that the exit code
    matches
- **Not included:** tests that need private project data (real footage, approved plans, golden
  renders, style memory or a local Resolve installation). They exist only in the private repository.

## Known limitations

- **Pipeline:** this snapshot stops at analysis, effects, composition and validation. The planner,
  render-spec compiler, critic loop and delivery packaging aren't included, so there is no
  end-to-end "song + footage → finished video" command here.
- **Semantic analysis and masks:** these depend on Apple Vision and only run on macOS.
- **Heuristics:** music structure labels and vocal-attack detection are heuristic. They report
  confidence and omit labels when evidence is weak, and human overrides are part of the design.
- **Vocal assist:** whisper.cpp is optional and treated as evidence only. It never moves or deletes
  a sync point.
- **Status:** internal tool, no stable public API. Interfaces may change.

## License

No licence is granted. This repository is shared for review only; all rights reserved.
