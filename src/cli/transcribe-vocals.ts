/**
 * Phase 2.5 OPTIONAL local vocal timing assist.
 *
 *   npm run transcribe-vocals -- --project projects/reference-project/music-analysis.config.json
 *                                [--manifest analysis/media-manifest.json] [--out analysis/music] [--no-cache]
 *                                [--model <local ggml model>] [--tag <name>]
 *
 * Model precedence: --model > vocalAssist.model (project config) > BALI_WHISPER_MODEL > base.en default.
 * --tag writes vocal-transcription.<tag>.json / <reportName>.<tag>.md (for A/B runs); only the untagged
 * vocal-transcription.json is picked up by analyze-music.
 *
 * Writes <out>/<mediaId>/vocal-transcription.json and diagnostics/<reportName>.md. analyze-music
 * picks the transcription up automatically. If the assist is disabled or whisper.cpp / its model is
 * unavailable, nothing is written and the Phase 2 view stays in force (exit code 0 with a notice).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveMediaTools } from "../media/ffmpeg.ts";
import { findMedia } from "../media/manifest.ts";
import { MediaManifestSchema } from "../media/schema.ts";
import { DEFAULT_CONFIG, analyzeMusic } from "../music/analyze.ts";
import { parseSync, resolveEvents } from "../music/overrides.ts";
import { literalToSeconds, parseTimeLiteral } from "../time/time.ts";
import { toDecimalString } from "../time/rational.ts";
import { DEFAULT_ASSIST_CONFIG, applyWordOverrides, buildVocalTranscription } from "../vocal/assist.ts";
import { vocalReport } from "../vocal/report.ts";
import { WhisperUnavailableError, resolveWhisper, runWhisper } from "../vocal/whisper.ts";
import { loadProject, writeJson } from "./project.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    manifest: { type: "string", default: "analysis/media-manifest.json" },
    out: { type: "string", default: "analysis/music" },
    "no-cache": { type: "boolean", default: false },
    model: { type: "string" },
    tag: { type: "string" },
  },
});
if (values.tag !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(values.tag)) throw new Error(`invalid --tag ${values.tag}`);
const suffix = values.tag ? `.${values.tag}` : "";
if (!values.project) throw new Error("--project <config.json> is required");
const secs = (s: string) => literalToSeconds(parseTimeLiteral(s));

const project = await loadProject(values.project);
const va = project.vocalAssist;
if (!va || !va.enabled) {
  console.log("vocal assist disabled in project config; Phase 2 view unchanged (nothing written)");
  process.exit(0);
}
let engine;
try {
  const model = values.model ?? va.model;
  engine = await resolveWhisper(model ? { ...process.env, BALI_WHISPER_MODEL: path.resolve(model) } : process.env);
} catch (e) {
  if (e instanceof WhisperUnavailableError) {
    console.log(`vocal assist unavailable: ${e.message}\nPhase 2 view unchanged (nothing written)`);
    process.exit(0);
  }
  throw e;
}

const manifest = MediaManifestSchema.parse(JSON.parse(await readFile(values.manifest!, "utf8")));
const entry = findMedia(manifest, project.mediaId);
if (!entry) throw new Error(`media ${project.mediaId} not found in ${values.manifest}`);
const tools = await resolveMediaTools();
const t0 = performance.now();
const { analysis } = await analyzeMusic(tools, entry, { ...DEFAULT_CONFIG, focusWindows: project.analysis.focusWindows }, {
  cacheDir: values["no-cache"] ? null : "cache/music",
});
const sync = project.sync ? parseSync(JSON.parse(await readFile(project.sync, "utf8"))) : null;
const pattern = va.patternId ? sync?.requiredPatterns.find((p) => p.id === va.patternId) : undefined;
if (va.patternId && !pattern) throw new Error(`pattern ${va.patternId} not found in ${project.sync}`);

const range = { start: secs(va.range.start), end: secs(va.range.end) };
const config = { ...DEFAULT_ASSIST_CONFIG, ...va };
const tw = performance.now();
const { raw, cacheHit } = await runWhisper(tools, engine, entry, analysis, range, config, values["no-cache"] ? null : "cache/vocal");
const whisperMs = Math.round(performance.now() - tw);

const phase2 = resolveEvents(analysis, sync);
const vt = applyWordOverrides(
  buildVocalTranscription({
    raw,
    analysis,
    range,
    pattern: pattern
      ? { patternId: pattern.id, start: secs(pattern.window.start), end: secs(pattern.window.end), matchEventTypes: pattern.matchEventTypes }
      : { patternId: null, start: range.start, end: range.end, matchEventTypes: ["vocal_attack"] },
    engine,
    config: {
      windowBars: config.windowBars,
      stepBars: config.stepBars,
      consensusToleranceMs: config.consensusToleranceMs,
      refinementWindowMs: config.refinementWindowMs,
      targetWords: config.targetWords,
    },
    generatedAt: new Date().toISOString(),
    phase2Status: new Map(phase2.events.filter((e) => e.patternId).map((e) => [e.id, e.identityStatus ?? ""])),
  }),
  sync,
);
const resolved = resolveEvents(analysis, sync, vt);
const totalMs = Math.round(performance.now() - t0);

const dir = path.join(values.out!, entry.mediaId);
const vtFile = path.join(dir, `vocal-transcription${suffix}.json`);
await writeJson(vtFile, vt);
const report = path.join(dir, "diagnostics", `${va.reportName}${suffix}.md`);
await mkdir(path.dirname(report), { recursive: true });
await writeFile(report, vocalReport(vt, resolved, { whisperMs: cacheHit ? null : whisperMs, totalMs, cacheHit }));

console.log(`model ${engine.modelName} (${engine.modelSha256.slice(0, 12)})`);
console.log(`${entry.source.fileName}: ${cacheHit ? "ASR cache hit" : `whisper ${whisperMs} ms`} (${vt.windows.length} windows, ${vt.words.length} words), total ${totalMs} ms`);
for (const o of vt.occurrences) {
  console.log(
    `  ${o.id} "${o.asrWords.join("/")}" raw ${toDecimalString(o.rawWhisperStart, 3)} s -> ${o.refinedSyncTime ? `${toDecimalString(o.refinedSyncTime, 3)} s (${o.refinementDeltaMs} ms)` : "unrefined"}: ${o.state}`,
  );
}
const counts = new Map<string, number>();
for (const a of vt.candidateAssessments) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
console.log(`  ${vt.candidateAssessments.length} Phase 2 candidates: ${[...counts.entries()].map(([k, n]) => `${k} ${n}`).join(", ")}`);
console.log(`wrote ${vtFile}\nwrote ${report}\n(run analyze-music to refresh music-events.resolved.json with the assist)`);
