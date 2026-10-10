/**
 * Semantic review sheets (fast human review): representative frame with the measured active picture
 * (green), primary subject (yellow) and the proposed 9:16 crop window (cyan), plus a compact label
 * panel. Deterministic shot selection covers framing classes, static vs moving, bordered and
 * watermarked shots. A Markdown table lists the same predictions for text review.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type MediaTools, runFfmpeg } from "../media/ffmpeg.ts";
import { DEFAULT_LABEL_FONT } from "../media/frames.ts";
import { toNumberApprox } from "../time/rational.ts";
import type { FootageAnalysis } from "../footage/schema.ts";
import type { SemanticIndex, SemanticMedia, SemanticShot } from "./schema.ts";

const top = (tags: SemanticShot["content"], n = 2) => tags.filter((t) => t.label !== "unknown").sort((a, b) => b.confidence - a.confidence).slice(0, n).map((t) => `${t.label}(${t.confidence.toFixed(2)})`).join(" ") || "unknown";

export function selectReviewShots(doc: SemanticMedia, fa: FootageAnalysis, n: number): SemanticShot[] {
  const byHero = [...doc.shots].sort((a, b) => b.features.heroPotential.score - a.features.heroPotential.score || (a.shotId < b.shotId ? -1 : 1));
  const picked: SemanticShot[] = [];
  const add = (s: SemanticShot | undefined) => {
    if (s && !picked.includes(s) && picked.length < n) picked.push(s);
  };
  const framings = ["extreme_close_up", "close_up", "medium_close_up", "medium", "medium_wide", "wide", "extreme_wide", "unknown"];
  for (let round = 0; round < 3; round++) for (const f of framings) add(byHero.filter((s) => s.framing.value === f)[round]);
  add(byHero.find((s) => s.cameraMotion.labels.some((l) => l.label === "locked_static")));
  add(byHero.find((s) => s.cameraMotion.labels.some((l) => l.label.startsWith("pan") || l.label === "handheld")));
  add(byHero.find((s) => s.subjectMotion.screenDirection.value === "left_to_right" || s.subjectMotion.screenDirection.value === "right_to_left"));
  add(byHero.find((s) => s.phase3.overlayIds.length > 0));
  add(byHero.find((s) => fa.shots.find((x) => x.shotId === s.shotId)!.activePicture.type !== "full_frame"));
  for (const s of byHero) add(s);
  return picked.sort((a, b) => (a.shotId < b.shotId ? -1 : 1));
}

export function reviewLines(s: SemanticShot, ix: SemanticIndex["shots"][number] | undefined): string[] {
  const f = s.features;
  const crop = f.cropPotential9x16;
  const warn = s.warnings.map((w) => w.code).concat(crop.risks.map((r) => r.toUpperCase())).slice(0, 3).join(" ") || "-";
  return [
    `${s.shotId.replace("shot:", "s")} ${toNumberApprox(s.start).toFixed(2)}s  ${s.framing.value} (${s.framing.confidence.toFixed(2)})`,
    `${s.subject.presence.value}/${s.subjectOrientation.value}  ${top(s.content)}`,
    `ctx ${top(s.context, 2)}`,
    `subj ${s.subjectMotion.labels.map((l) => l.label).join(",")} ${s.subjectMotion.screenDirection.value}  cam ${s.cameraMotion.labels.map((l) => l.label).join(",")}`,
    `hero ${f.heroPotential.score.toFixed(2)} open ${f.openingPotential.score.toFixed(2)} drop ${f.dropPotential.score.toFixed(2)} nov ${ix ? ix.visualNovelty.score.toFixed(2) : "-"}`,
    `9:16 ${crop.score.toFixed(2)} ${crop.difficulty} x${crop.upscaleFactor}  ${warn}`,
  ];
}

export async function writeSemanticReview(
  tools: MediaTools,
  doc: SemanticMedia,
  fa: FootageAnalysis,
  index: SemanticIndex,
  frameFiles: Map<number, string>,
  sampleW: number,
  outDir: string,
  n = 12,
): Promise<{ sheets: string[]; markdown: string }> {
  const shots = selectReviewShots(doc, fa, n);
  const dir = path.join(outDir, doc.mediaId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const work = path.join(dir, ".cells");
  await mkdir(work, { recursive: true });
  const ixOf = new Map(index.shots.filter((s) => s.mediaId === doc.mediaId).map((s) => [s.shotId, s]));
  const cellW = 360;
  const scale = cellW / fa.geometry.display.w;
  const cellH = 2 * Math.round((fa.geometry.display.h * scale) / 2);
  const box = (x: number, y: number, w: number, h: number, c: string) => `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.max(2, Math.round(w))}:h=${Math.max(2, Math.round(h))}:color=${c}:t=2`;
  const cells: string[] = [];
  for (const [i, s] of shots.entries()) {
    const shot = fa.shots.find((x) => x.shotId === s.shotId)!;
    const rep = s.samples.find((x) => x.representative) ?? s.samples[0]!;
    const ar = shot.activePicture.activeRect;
    const filters = [`scale=${cellW}:${cellH}`, box(ar.x * scale, ar.y * scale, ar.w * scale, ar.h * scale, "lime@0.8")];
    if (s.subject.primaryBox) {
      const b = s.subject.primaryBox;
      filters.push(box((ar.x + b.x * ar.w) * scale, (ar.y + b.y * ar.h) * scale, b.w * ar.w * scale, b.h * ar.h * scale, "yellow@0.9"));
    }
    const crop = s.features.cropPotential9x16;
    if (!crop.nativeVertical && crop.centerPath.length) {
      const cx = crop.centerPath[s.samples.indexOf(rep)]?.centerX ?? crop.centerPath[0]!.centerX;
      filters.push(box((cx - crop.cropWidth / 2) * scale, ar.y * scale, crop.cropWidth * scale, ar.h * scale, "cyan@0.9"));
    }
    const textFile = path.join(work, `t${i}.txt`);
    await writeFile(textFile, reviewLines(s, ixOf.get(s.shotId)).join("\n"));
    filters.push(`pad=${cellW}:${cellH + 96}:0:0:color=0x151515`, `drawtext=fontfile=${DEFAULT_LABEL_FONT}:textfile=${textFile}:x=5:y=${cellH + 4}:fontsize=11:fontcolor=white:line_spacing=3`);
    const cell = path.join(work, `cell_${String(i).padStart(3, "0")}.png`);
    await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-i", frameFiles.get(rep.frameIndex)!, "-vf", filters.join(","), "-y", cell]);
    cells.push(cell);
  }
  void sampleW;
  const cols = fa.geometry.display.h > fa.geometry.display.w ? 6 : 4;
  const rows = Math.ceil(shots.length / cols);
  for (let i = shots.length; i < cols * rows; i++) {
    const c = path.join(work, `cell_${String(i).padStart(3, "0")}.png`);
    await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=0x101010:s=${cellW}x${cellH + 96}:d=0.04`, "-frames:v", "1", "-y", c]);
  }
  const sheet = path.join(dir, "semantic-review.jpg");
  await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-framerate", "1", "-i", path.join(work, "cell_%03d.png"), "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x101010`, "-frames:v", "1", "-q:v", "4", "-y", sheet]);
  await rm(work, { recursive: true, force: true });
  const md = [
    `# Semantic review — ${doc.mediaId}`,
    "",
    "Green = active picture, yellow = primary subject, cyan = proposed 9:16 crop window.",
    "",
    "| shot | time | framing | subject/orientation | content | context | subject motion | camera | hero | open | drop | 9:16 | warnings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...shots.map((s) => {
      const f = s.features;
      return `| ${s.shotId} | ${toNumberApprox(s.start).toFixed(2)} | ${s.framing.value} ${s.framing.confidence} | ${s.subject.presence.value}/${s.subjectOrientation.value} | ${top(s.content, 3)} | ${top(s.context, 3)} | ${s.subjectMotion.labels.map((l) => l.label).join(",")} (${s.subjectMotion.screenDirection.value}) | ${s.cameraMotion.labels.map((l) => l.label).join(",")} | ${f.heroPotential.score} | ${f.openingPotential.score} | ${f.dropPotential.score} | ${f.cropPotential9x16.score} ${f.cropPotential9x16.difficulty} | ${[...s.warnings.map((w) => w.code), ...f.cropPotential9x16.risks].join(" ")} |`;
    }),
    "",
  ].join("\n");
  const mdFile = path.join(dir, "semantic-review.md");
  await writeFile(mdFile, md);
  return { sheets: [sheet], markdown: mdFile };
}
