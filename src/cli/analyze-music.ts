/**
 * Analyze a project's music track and write analysis + resolved events + diagnostics.
 *
 *   npm run analyze-music -- --project projects/reference-project/music-analysis.config.json
 *                            [--manifest analysis/media-manifest.json] [--out analysis/music] [--no-cache]
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveMediaTools } from "../media/ffmpeg.ts";
import { findMedia } from "../media/manifest.ts";
import { MediaManifestSchema } from "../media/schema.ts";
import { DEFAULT_CONFIG, analyzeMusic } from "../music/analyze.ts";
import { writeDiagnostics } from "../music/diagnostics.ts";
import { decodeMono } from "../music/features.ts";
import { parseSync, resolveEvents } from "../music/overrides.ts";
import { toDecimalString } from "../time/rational.ts";
import { literalToSeconds, parseTimeLiteral } from "../time/time.ts";
import { applyWordOverrides } from "../vocal/assist.ts";
import { writeOccurrenceReview } from "../vocal/occurrence-review.ts";
import { type VocalOccurrences, resolveHumanOccurrences, vocalFeatureProvider } from "../vocal/occurrences.ts";
import { type VocalTranscription, VocalTranscriptionSchema } from "../vocal/schema.ts";
import { loadProject, writeJson } from "./project.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    manifest: { type: "string", default: "analysis/media-manifest.json" },
    out: { type: "string", default: "analysis/music" },
    "no-cache": { type: "boolean", default: false },
    "no-vocal-assist": { type: "boolean", default: false },
  },
});
if (!values.project) throw new Error("--project <config.json> is required");

const project = await loadProject(values.project);
const manifest = MediaManifestSchema.parse(JSON.parse(await readFile(values.manifest!, "utf8")));
const entry = findMedia(manifest, project.mediaId);
if (!entry) throw new Error(`media ${project.mediaId} not found in ${values.manifest}`);
const tools = await resolveMediaTools();
const config = { ...DEFAULT_CONFIG, focusWindows: project.analysis.focusWindows };

const t0 = performance.now();
const { analysis, cacheHit, cacheFile } = await analyzeMusic(tools, entry, config, {
  cacheDir: values["no-cache"] ? null : "cache/music",
});
const sync = project.sync ? parseSync(JSON.parse(await readFile(project.sync, "utf8"))) : null;
const dir = path.join(values.out!, entry.mediaId);
// Optional Phase 2.5 vocal assist: used when enabled in the project and its artifact exists.
let vocal: VocalTranscription | null = null;
if (project.vocalAssist?.enabled && !values["no-vocal-assist"]) {
  try {
    vocal = applyWordOverrides(
      VocalTranscriptionSchema.parse(JSON.parse(await readFile(path.join(dir, "vocal-transcription.json"), "utf8"))),
      sync,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    console.log("  vocal assist enabled but no vocal-transcription.json yet (run transcribe-vocals); Phase 2 view");
  }
}
// Human ground-truth occurrences (music-sync.json): primary attack + effect repeats per window.
const groundTruth: VocalOccurrences[] = [];
let samples: Float32Array | null = null;
const written: string[] = [];
if (sync?.occurrenceGroundTruth?.length) {
  samples = await decodeMono(tools, entry);
  // Every Whisper transcription on disk (default + tagged A/B runs) is evidence only.
  const transcriptions = [];
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => /^vocal-transcription(\.[a-z0-9._-]+)?\.json$/.test(x)).sort()) {
    transcriptions.push(VocalTranscriptionSchema.parse(JSON.parse(await readFile(path.join(dir, f), "utf8"))));
  }
  const secs = (lit: string) => literalToSeconds(parseTimeLiteral(lit));
  const vocalAttacks = analysis.events.filter((e) => e.type === "vocal_attack");
  for (const g of sync.occurrenceGroundTruth) {
    const pattern = sync.requiredPatterns.find((p) => p.id === g.patternId)!;
    const lo = secs(pattern.window.start);
    const hi = secs(pattern.window.end);
    const near = vocalAttacks.filter((e) => e.id === g.referenceEventId || (e.time.num / e.time.den >= lo.num / lo.den - 1 && e.time.num / e.time.den <= hi.num / hi.den + 1));
    const occ = resolveHumanOccurrences({
      analysis,
      patternId: g.patternId,
      label: pattern.label,
      exhaustive: g.exhaustive,
      referenceEventId: g.referenceEventId,
      windows: g.occurrences.map((o) => ({ occurrenceId: o.id, start: secs(o.window.start), end: secs(o.window.end) })),
      features: vocalFeatureProvider(samples, near),
      transcriptions,
      targetWord: pattern.label,
    });
    groundTruth.push(occ);
    const base = path.join(dir, "diagnostics", `${g.patternId.replace(/^usr:/, "")}-occurrences`);
    written.push(...(await writeOccurrenceReview(samples, occ, base)));
  }
  await writeJson(path.join(dir, "vocal-occurrences.json"), groundTruth);
  written.push(path.join(dir, "vocal-occurrences.json"));
}
const resolved = resolveEvents(analysis, sync, vocal, groundTruth);

await writeJson(path.join(dir, "music-analysis.json"), analysis);
await writeJson(path.join(dir, "music-events.resolved.json"), resolved);
if (project.diagnostics.length) {
  samples ??= await decodeMono(tools, entry);
  for (const w of project.diagnostics) {
    written.push(...(await writeDiagnostics(tools, analysis, resolved, sync, samples, w, path.join(dir, "diagnostics"))));
  }
}

const bpm = analysis.tempo.canonicalBpm;
console.log(`${entry.source.fileName}: ${cacheHit ? "cache hit" : "analysed"} in ${Math.round(performance.now() - t0)} ms${cacheFile ? ` (${cacheFile})` : ""}`);
console.log(`  tempo ${bpm.num}/${bpm.den} BPM (${analysis.tempo.snapRule}), confidence ${analysis.tempo.bpmConfidence}; ${analysis.beats.length} beats, ${analysis.bars.length} bars, ${analysis.phrases.length} phrases, ${analysis.sections.length} sections`);
console.log(`  loudness ${analysis.curves.loudness.integratedLufs} LUFS; events ${analysis.events.length}; regions ${analysis.regions.length}; warnings ${analysis.warnings.map((w) => w.code).join(", ")}`);
console.log(`  vocal assist: ${resolved.vocalAssist ? `applied (${resolved.vocalAssist.model}, ${resolved.vocalAssist.cacheKey})` : "not applied"}`);
console.log(`  resolved: ${resolved.events.length} events (${resolved.events.filter((e) => e.tier === "USER_REQUIRED").length} user-required)`);
for (const e of resolved.events.filter((x) => x.origin === "user")) console.log(`  user ${e.id} @ ${toDecimalString(e.time, 3)} s`);
console.log(`wrote ${path.join(dir, "music-analysis.json")}\nwrote ${path.join(dir, "music-events.resolved.json")}`);
for (const f of written) console.log(`wrote ${f}`);
