/** Human-readable report for a vocal transcription + the resolved view it produced. */

import type { ResolvedMusicEvents } from "../music/schema.ts";
import { type Rational, toDecimalString, toNumberApprox } from "../time/rational.ts";
import type { VocalTranscription } from "./schema.ts";

const clock = (r: Rational) => {
  const s = toNumberApprox(r);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface ReportTiming {
  whisperMs: number | null;
  totalMs: number;
  cacheHit: boolean;
}

export function vocalReport(vt: VocalTranscription, resolved: ResolvedMusicEvents, timing: ReportTiming): string {
  const L: string[] = [];
  const byId = new Map(resolved.events.map((e) => [e.id, e]));
  const words = new Map(vt.words.map((w) => [w.id, w]));
  L.push(`# Vocal timing assist — ${clock(vt.analyzedRange.start)}–${clock(vt.analyzedRange.end)}`);
  L.push("");
  L.push(
    "> Whisper is an **assistant, not the timing authority**. Raw Whisper times are kept untouched; a refined sync time is always an existing Phase 2 signal event inside ±" +
      `${vt.config.refinementWindowMs} ms. CONFIRMED_BY_SIGNAL is machine evidence, not a human decision — only a user override makes an event CONFIRMED.`,
  );
  L.push("");
  L.push(`- Source: \`${vt.sourceMediaId}\` (fingerprint \`${vt.sourceFingerprint.slice(0, 16)}…\`)`);
  L.push(`- Target window: ${clock(vt.targetWindow.start)}–${clock(vt.targetWindow.end)}${vt.patternId ? ` (pattern \`${vt.patternId}\`)` : ""}; target words: ${vt.config.targetWords.join(", ")}`);
  L.push(`- Engine: whisper.cpp ${vt.engine.version} (\`${vt.engine.commit.slice(0, 12)}\`), network-denied sandbox: ${vt.engine.networkSandbox ? "yes" : "no"}; args \`${vt.engine.args.join(" ")}\``);
  L.push(`- Model: \`${vt.model.name}\` (${(vt.model.sizeBytes / 1e6).toFixed(1)} MB, sha256 \`${vt.model.sha256.slice(0, 16)}…\`), language ${vt.language}`);
  L.push(`- Windows: ${vt.windows.length} × ${vt.config.windowBars} bars, step ${vt.config.stepBars} bar(s), bar-aligned to the Phase 2 grid; consensus tolerance ±${vt.config.consensusToleranceMs} ms`);
  L.push(`- Run: ${timing.cacheHit ? "ASR cache hit" : `Whisper ${timing.whisperMs} ms`}; total ${timing.totalMs} ms; cache key \`${vt.cacheKey}\``);
  L.push("");
  L.push("## Occurrences of the target word");
  L.push("");
  if (!vt.occurrences.length) L.push("_Whisper did not hear the target word in this range._");
  for (const o of vt.occurrences) {
    const ev = [...byId.values()].find((e) => e.vocalAssist?.occurrenceId === o.id && (e.detectedEventId === o.refinedFromEventId || e.id.startsWith("vox:")));
    L.push(`### \`${o.id}\` — **${o.state}**${ev && ev.identityStatus !== o.state ? ` → final **${ev.identityStatus}**` : ""}`);
    L.push("");
    L.push("| field | value |");
    L.push("| --- | --- |");
    L.push(`| Whisper word(s) | ${o.asrWords.map((w) => `“${cell(w)}”`).join(", ")} (${o.matchKind}; hearings ${o.hearingWordIds.join(", ")}) |`);
    L.push(`| raw Whisper start / end | ${clock(o.rawWhisperStart)} / ${clock(o.rawWhisperEnd)} (${toDecimalString(o.rawWhisperStart, 4)} s) |`);
    L.push(`| ASR confidence (mean token p) | ${o.asrConfidence} — consensus ${o.consensusWindows} window(s) |`);
    L.push(`| nearest Phase 2 candidate | ${o.nearestPhase2Candidate ? `\`${o.nearestPhase2Candidate.eventId}\` Δ ${o.nearestPhase2Candidate.deltaMs} ms (conf ${o.nearestPhase2Candidate.confidence})` : "—"} |`);
    L.push(`| nearest onset | ${o.nearestOnset ? `\`${o.nearestOnset.eventId}\` Δ ${o.nearestOnset.deltaMs} ms (strength ${o.nearestOnset.strength})` : "—"} |`);
    L.push(`| Whisper start → detected attack | ${o.refinementDeltaMs === null ? "no signal event within the window" : `${o.refinementDeltaMs} ms (${o.refinementMethod}, \`${o.refinedFromEventId}\`)`} |`);
    L.push(`| refined sync time | ${o.refinedSyncTime ? `${clock(o.refinedSyncTime)} (${toDecimalString(o.refinedSyncTime, 6)} s)` : "— (raw time only)"} |`);
    L.push(`| beat relation | ${o.beat ? `\`${o.beat.beatId}\` bar ${o.beat.barIndex} beat ${o.beat.beatInBar}, ${o.beat.offsetMs >= 0 ? "+" : ""}${o.beat.offsetMs} ms` : "—"} |`);
    L.push(`| refined confidence (heuristic) | ${o.refinedConfidence} |`);
    L.push(`| state | ${o.state} — ${cell(o.reason)} |`);
    if (ev) L.push(`| resolved event | \`${ev.id}\` ${clock(ev.time)} tier ${ev.tier}, mandatory ${ev.mandatory}${ev.overrideIds.length ? `, overrides ${ev.overrideIds.join(", ")}` : ""} |`);
    else L.push(`| resolved event | — (outside the pattern window or rejected; not a sync target) |`);
    L.push("");
  }
  L.push(`## Phase 2 candidates in the target window (${vt.candidateAssessments.length})`);
  L.push("");
  const counts = new Map<string, number>();
  for (const a of vt.candidateAssessments) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
  L.push([...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(" · "));
  L.push("");
  L.push("| candidate | time | Phase 2 | assist | final | ASR heard here | reason |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const a of vt.candidateAssessments) {
    const e = byId.get(a.eventId);
    const heard = a.overlappingWords.map((id) => words.get(id)?.normalized ?? id).join(", ");
    L.push(
      `| \`${a.eventId}\` | ${clock(a.time)} | ${a.phase2Status ?? "—"} | ${a.state} | ${e ? `${e.identityStatus}${e.mandatory ? "" : " (not mandatory)"}` : "excluded"} | ${cell(heard) || "—"} | ${cell(a.reason)} |`,
    );
  }
  L.push("");
  L.push("## Transcript by window (raw Whisper, with flags)");
  L.push("");
  for (const w of vt.windows) {
    const ws = vt.words.filter((x) => x.windowId === w.id);
    const text = ws.map((x) => (x.flags.length ? `~~${x.rawText.trim()}~~` : x.rawText.trim())).join(" ");
    L.push(`- \`${w.id}\` ${clock(w.start)}–${clock(w.end)} (${w.anchoredToBarId}): ${text || "_(nothing)_"}`);
  }
  L.push("");
  L.push("Struck-through words are flagged (non-speech tag, repetition loop, compressed timestamp or window edge) and never count as identity evidence.");
  L.push("");
  if (vt.warnings.length || resolved.warnings.length) {
    L.push("## Warnings");
    L.push("");
    for (const w of [...vt.warnings, ...resolved.warnings]) L.push(`- **${w.code}** — ${w.message}`);
    L.push("");
  }
  L.push("## Human confirmation");
  L.push("");
  L.push("Add overrides to `music-sync.json` → `eventOverrides` (they always win):");
  L.push("");
  L.push("```json");
  const example = vt.occurrences.find((o) => resolved.events.some((e) => e.vocalAssist?.occurrenceId === o.id));
  L.push(`{ "id": "usr:confirm-hook-1", "targetEventId": "${example?.id ?? "occ:hook:NNNNN"}", "action": "confirm" }`);
  L.push(`{ "id": "usr:retime-hook-1", "targetEventId": "<event or occ id>", "action": "retime", "time": "00:01:27.230" }`);
  L.push(`{ "id": "usr:not-hook-1", "targetEventId": "<event id>", "action": "exclude" }`);
  L.push("```");
  L.push("");
  return L.join("\n");
}
