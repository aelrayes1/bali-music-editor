/**
 * FX compositions (Phase 6A):
 *  - FxReel: segments played back to back, each one FxClip at full size (isolated previews, QC).
 *  - FxDemo: FX_DEMO triptych — per segment three variants (e.g. SUBTLE / MEDIUM / STRONG) side
 *    by side, each rendered at 1080x1920 and scaled into its panel, with a small label.
 */

import type React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { ResolvedFx } from "../../../src/fx/core.ts";
import type { SubjectInsert } from "../../../src/fx/subject/insert.ts";
import { FxClip } from "./FxClip.tsx";

export interface FxSegment {
  id: string;
  file: string;
  frames: number;
  effects: ResolvedFx[];
  label?: string;
  inserts?: SubjectInsert[];
}

export interface FxReelProps extends Record<string, unknown> {
  width: number;
  height: number;
  fps: number;
  segments: FxSegment[];
  audio: string | null;
}

export const FxReel: React.FC<FxReelProps> = ({ width, height, segments, audio }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {segments.map((s) => {
        const el = (
          <Sequence key={s.id} from={from} durationInFrames={s.frames} name={s.id}>
            <FxClip id={s.id} file={s.file} frames={s.frames} effects={s.effects} width={width} height={height} inserts={s.inserts} />
          </Sequence>
        );
        from += s.frames;
        return el;
      })}
      {audio ? <Audio src={staticFile(audio)} /> : null}
    </AbsoluteFill>
  );
};

export interface FxDemoProps extends Record<string, unknown> {
  width: number;
  height: number;
  fps: number;
  clipWidth: number;
  clipHeight: number;
  segments: Array<{ id: string; title: string; frames: number; variants: FxSegment[] }>;
  audio: string | null;
}

export const FxDemo: React.FC<FxDemoProps> = ({ width, height, clipWidth, clipHeight, segments, audio }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0c0c0c" }}>
      {segments.map((seg) => {
        const n = seg.variants.length;
        const pw = width / n;
        const scale = Math.min(pw / clipWidth, height / clipHeight);
        const el = (
          <Sequence key={seg.id} from={from} durationInFrames={seg.frames} name={seg.id}>
            {seg.variants.map((v, i) => (
              <div key={v.id} style={{ position: "absolute", left: i * pw, top: 0, width: pw, height, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: (pw - clipWidth * scale) / 2, top: 0, width: clipWidth, height: clipHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                  <FxClip id={v.id} file={v.file} frames={v.frames} effects={v.effects} width={clipWidth} height={clipHeight} inserts={v.inserts} />
                </div>
                <div style={{ position: "absolute", left: 10, top: 8, fontFamily: "Menlo, monospace", fontSize: 18, color: "#ffffff", background: "rgba(0,0,0,0.55)", padding: "3px 7px" }}>
                  {seg.title} · {v.label}
                </div>
              </div>
            ))}
          </Sequence>
        );
        from += seg.frames;
        return el;
      })}
      {audio ? <Audio src={staticFile(audio)} /> : null}
    </AbsoluteFill>
  );
};
