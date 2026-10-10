/**
 * Shot contact sheets: one cell per shot (its representative frame), paginated, with the measured
 * active-picture rectangle (green) and overlay boxes (red) drawn, labelled with shot id, exact time
 * and frame index. A JSON map per page recovers media id, shot id and exact source time per cell.
 * Frames come from Phase 1's verified extractFrame (exact frame, rotation and pixel aspect applied).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type MediaTools, probePacketPts, runFfmpeg } from "../media/ffmpeg.ts";
import { DEFAULT_LABEL_FONT, extractFrame } from "../media/frames.ts";
import type { MediaEntry } from "../media/schema.ts";
import { rational, toDecimalString } from "../time/rational.ts";
import type { FootageAnalysis } from "./schema.ts";

export interface ShotSheetOptions {
  outDir: string;
  cols?: number;
  rows?: number;
  /** Cell width for landscape media; portrait media use 0.6x. */
  cellWidth?: number;
}

export interface ShotSheetPage {
  sheet: string;
  mapping: string;
  shots: string[];
}

export async function shotContactSheets(tools: MediaTools, entry: MediaEntry, a: FootageAnalysis, options: ShotSheetOptions): Promise<ShotSheetPage[]> {
  const cols = options.cols ?? 5;
  const rows = options.rows ?? 4;
  const portrait = a.geometry.display.h > a.geometry.display.w;
  const cellWidth = 2 * Math.round(((options.cellWidth ?? 240) * (portrait ? 0.6 : 1)) / 2);
  const scale = cellWidth / a.geometry.display.w;
  const cellHeight = 2 * Math.round((a.geometry.display.h * scale) / 2);
  const dir = path.join(options.outDir, a.source.mediaId, "contact");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const work = path.join(dir, ".cells");
  await mkdir(work, { recursive: true });
  const sortedPts = (await probePacketPts(tools, entry.source.absolutePath, entry.video!.streamIndex)).sort((x, y) => x - y);
  const perPage = cols * rows;
  const pages: ShotSheetPage[] = [];
  const box = (r: { x: number; y: number; w: number; h: number }, color: string) =>
    `drawbox=x=${Math.round(r.x * scale)}:y=${Math.round(r.y * scale)}:w=${Math.max(2, Math.round(r.w * scale))}:h=${Math.max(2, Math.round(r.h * scale))}:color=${color}:t=2`;
  for (let p = 0; p * perPage < a.shots.length; p++) {
    const shots = a.shots.slice(p * perPage, (p + 1) * perPage);
    const cells = [];
    for (const [i, s] of shots.entries()) {
      const raw = path.join(work, `raw_${String(i).padStart(3, "0")}.png`);
      const f = await extractFrame(tools, entry, s.representative.time, raw, cellWidth, sortedPts);
      const label = `${s.shotId.replace("shot:", "s")}  ${toDecimalString(rational(f.frameSeconds.num, f.frameSeconds.den), 3)}s  f${f.frameIndex ?? "?"}`;
      const filters = [
        `scale=${cellWidth}:${cellHeight}`,
        box(s.activePicture.activeRect, "lime@0.9"),
        ...a.overlays.filter((o) => s.overlayIds.includes(o.id)).map((o) => box(o.bbox, o.kind === "edge_structure" ? "yellow@0.7" : o.location === "picture" ? "red@0.9" : "orange@0.9")),
        `drawtext=fontfile=${DEFAULT_LABEL_FONT}:text='${label}':x=6:y=6:fontsize=${Math.max(10, Math.round(cellWidth / 18))}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`,
      ];
      const cell = path.join(work, `cell_${String(i).padStart(3, "0")}.png`);
      await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-i", raw, "-vf", filters.join(","), "-y", cell]);
      cells.push({
        cell: i,
        row: Math.floor(i / cols),
        col: i % cols,
        mediaId: a.source.mediaId,
        shotId: s.shotId,
        shotStart: s.start,
        shotEnd: s.end,
        requestedSeconds: f.requestedSeconds,
        frameSeconds: f.frameSeconds,
        framePts: f.framePts,
        frameIndex: f.frameIndex,
        label,
      });
    }
    // pad the last page with blank cells so tile() gets a full grid
    for (let i = shots.length; i < perPage; i++) {
      await runFfmpeg(tools, ["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=0x101010:s=${cellWidth}x${cellHeight}:d=0.04`, "-frames:v", "1", "-y", path.join(work, `cell_${String(i).padStart(3, "0")}.png`)]);
    }
    const stem = `shots-p${String(p + 1).padStart(2, "0")}`;
    const sheet = path.join(dir, `${stem}.jpg`);
    await runFfmpeg(tools, [
      "-hide_banner", "-nostdin", "-v", "error",
      "-framerate", "1", "-i", path.join(work, "cell_%03d.png"),
      "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x101010`,
      "-frames:v", "1", "-q:v", "4", "-y", sheet,
    ]);
    const mapping = path.join(dir, `${stem}.json`);
    await writeFile(
      mapping,
      JSON.stringify(
        {
          mediaId: a.source.mediaId,
          source: `${entry.source.rootId}/${entry.source.relativePath}`,
          page: p + 1,
          sheet: path.basename(sheet),
          cols,
          rows,
          cellWidth,
          cellHeight,
          display: a.geometry.display,
          legend: { green: "measured active picture", red: "overlay inside the picture (watermark/logo candidate)", orange: "static graphic inside black bars", yellow: "static edge structure (analog blanking / frame line)" },
          cells,
        },
        null,
        2,
      ) + "\n",
    );
    pages.push({ sheet, mapping, shots: shots.map((s) => s.shotId) });
    for (let i = 0; i < perPage; i++) {
      await rm(path.join(work, `raw_${String(i).padStart(3, "0")}.png`), { force: true });
      await rm(path.join(work, `cell_${String(i).padStart(3, "0")}.png`), { force: true });
    }
  }
  await rm(work, { recursive: true, force: true });
  return pages;
}
