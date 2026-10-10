/**
 * Minimal listening package for human ground-truth occurrences: one combined WAV (source audio,
 * distinctive tick on each PRIMARY sync point, soft tick on each effect repeat, two-tone tick on
 * ambiguous candidates), one snippet WAV (a ~1.2 s excerpt per occurrence) and a short table.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clock, wav16 } from "../music/diagnostics.ts";
import { SAMPLE_RATE } from "../music/features.ts";
import { toDecimalString, toNumberApprox } from "../time/rational.ts";
import type { VocalOccurrences } from "./occurrences.ts";

type Kind = "primary" | "repeat" | "ambiguous";

function tick(buf: Float32Array, at: number, kind: Kind): void {
  const spec: Record<Kind, Array<[number, number, number]>> = {
    primary: [[2200, 0.95, 0]], // [hz, gain, offset s]
    repeat: [[900, 0.3, 0]],
    ambiguous: [[1300, 0.7, 0], [1900, 0.7, 0.05]],
  };
  for (const [hz, gain, off] of spec[kind]) {
    const start = at + Math.round(off * SAMPLE_RATE);
    const n = Math.round(0.03 * SAMPLE_RATE);
    for (let k = 0; k < n; k++) {
      const i = start + k;
      if (i >= 0 && i < buf.length) buf[i]! += gain * Math.sin((2 * Math.PI * hz * k) / SAMPLE_RATE) * Math.exp(-k / (0.007 * SAMPLE_RATE));
    }
  }
}

function marks(occ: VocalOccurrences): Array<{ t: number; kind: Kind }> {
  return occ.occurrences.flatMap((o) => [
    ...(o.primaryAttack ? [{ t: toNumberApprox(o.primaryAttack.time), kind: "primary" as const }] : []),
    ...o.effectRepeats.map((r) => ({ t: toNumberApprox(r.time), kind: "repeat" as const })),
    ...o.ambiguousCandidates.map((a) => ({ t: toNumberApprox(a.time), kind: "ambiguous" as const })),
  ]);
}

export async function writeOccurrenceReview(samples: Float32Array, occ: VocalOccurrences, base: string): Promise<string[]> {
  const all = marks(occ);
  const from = Math.max(0, Math.min(...occ.occurrences.map((o) => toNumberApprox(o.humanWindow.start))) - 0.4);
  const to = Math.max(...occ.occurrences.map((o) => toNumberApprox(o.humanWindow.end))) + 0.3;
  const s0 = Math.round(from * SAMPLE_RATE);
  const combined = samples.slice(s0, Math.round(to * SAMPLE_RATE)).map((v) => v * 0.6);
  for (const m of all) tick(combined, Math.round(m.t * SAMPLE_RATE) - s0, m.kind);

  const PRE = 0.4;
  const POST = 0.8;
  const GAP = 0.4;
  const snippets = new Float32Array(Math.round(occ.occurrences.length * (PRE + POST + GAP) * SAMPLE_RATE));
  occ.occurrences.forEach((o, i) => {
    const anchor = toNumberApprox(o.syncTarget ?? o.ambiguousCandidates[0]?.time ?? o.humanWindow.start);
    const at = Math.round(i * (PRE + POST + GAP) * SAMPLE_RATE);
    const src = Math.round((anchor - PRE) * SAMPLE_RATE);
    const len = Math.round((PRE + POST) * SAMPLE_RATE);
    for (let j = 0; j < len; j++) snippets[at + j] = 0.6 * (samples[src + j] ?? 0) * Math.min(1, j / 441, (len - j) / 441);
    for (const m of all) {
      const off = m.t - (anchor - PRE);
      if (off >= 0 && off < PRE + POST) tick(snippets, at + Math.round(off * SAMPLE_RATE), m.kind);
    }
  });

  const L: string[] = [];
  L.push(`# “${occ.label}” — ${occ.occurrences.length} human-confirmed occurrences`);
  L.push("");
  L.push(`Reference attack: \`${occ.reference.eventId}\` (${clock(toNumberApprox(occ.reference.time))}). Measured effect-repeat delay: ${occ.measuredRepeatDelayMs.values.map((v) => `${v} ms`).join(", ") || "none"}${occ.measuredRepeatDelayMs.median !== null ? ` (median ${occ.measuredRepeatDelayMs.median} ms)` : ""}.`);
  L.push("");
  L.push(`- \`${base.split("/").pop()}-combined.wav\` — ${clock(from)}–${clock(to)}: **sharp high tick = PRIMARY sync point**, soft low tick = effect repeat${all.some((m) => m.kind === "ambiguous") ? ", two-tone tick = AMBIGUOUS candidate" : ""}.`);
  L.push(`- \`${base.split("/").pop()}-snippets.wav\` — one ${(PRE + POST).toFixed(1)} s excerpt per occurrence (tick ${PRE} s in), in order, ${GAP} s apart.`);
  L.push("");
  L.push("| # | window | preferred sync | event | confidence | effect | repeats | Whisper |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  occ.occurrences.forEach((o, i) => {
    const w = `${clock(toNumberApprox(o.humanWindow.start))}–${clock(toNumberApprox(o.humanWindow.end))}`;
    const sync = o.syncTarget
      ? `**${clock(toNumberApprox(o.syncTarget))}** (${toDecimalString(o.syncTarget, 6)} s)`
      : o.status === "AMBIGUOUS"
        ? `AMBIGUOUS: ${o.ambiguousCandidates.map((a) => clock(toNumberApprox(a.time))).join(" or ")}`
        : "NO CANDIDATE";
    const reps = o.effectRepeats.map((r) => `${clock(toNumberApprox(r.time))} (+${Math.round(r.delayMs)} ms, ${r.levelDbRelative >= 0 ? "+" : ""}${r.levelDbRelative} dB)`).join("; ") || "—";
    const heard = [...new Set(o.whisperEvidence.filter((x) => x.target).map((x) => `${x.model}: “${x.heard}”`))].join(", ") || "not heard";
    L.push(`| ${i + 1} | ${w} | ${sync} | \`${o.primaryAttack?.eventId ?? "—"}\` sim ${o.primaryAttack?.similarityToReference ?? "—"} | ${o.confidence} | ${o.effectCharacter} (${o.effectConfidence}) | ${reps} | ${heard} |`);
  });
  L.push("");
  for (const [i, o] of occ.occurrences.entries()) L.push(`${i + 1}. ${o.reasoning}. Effect: ${o.effectEvidence}.`);
  L.push("");
  L.push("To correct a sync point: `music-sync.json` → `eventOverrides`, e.g. `{ \"id\": \"usr:fix-1\", \"targetEventId\": \"" + (occ.occurrences[0]?.occurrenceId ?? "usr:…") + "\", \"action\": \"retime\", \"time\": \"00:01:21.600\" }`.");
  L.push("");
  await mkdir(path.dirname(base), { recursive: true });
  await writeFile(`${base}.md`, L.join("\n"));
  await writeFile(`${base}-combined.wav`, wav16(combined));
  await writeFile(`${base}-snippets.wav`, wav16(snippets));
  return [`${base}.md`, `${base}-combined.wav`, `${base}-snippets.wav`];
}
