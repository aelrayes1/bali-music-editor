/**
 * FxClip: one conformed clip (RGB intermediate, CFR, frame j = clip-local frame j) with resolved
 * Phase 6A effects applied in the fixed order: time remap (or a Phase 6B subject insert) -> echo
 * layers -> transform -> rgbSplit -> grain -> flash. All per-frame values come from the shared pure
 * core (src/fx/core.ts, src/fx/subject/insert.ts); this component only draws them. No randomness,
 * no clocks.
 */

import type React from "react";
import { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { type ResolvedFx, flashAt, grainAt, grainPixels, layersAt, rgbSplitAt, transformAt } from "../../../src/fx/core.ts";
import { type SubjectInsert, insertFrameAt } from "../../../src/fx/subject/insert.ts";

export interface FxClipProps {
  id: string;
  file: string;
  frames: number;
  effects: ResolvedFx[];
  width: number;
  height: number;
  /** Phase 6B subject-effect inserts (validated by the caller: no 6A remap on the same frames) */
  inserts?: SubjectInsert[];
}

const RgbSplitFilter: React.FC<{ id: string; dx: number; dy: number; mix: number }> = ({ id, dx, dy, mix }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx={dx} dy={dy} result="ro" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feOffset in="b" dx={-dx} dy={-dy} result="bo" />
      <feComposite in="ro" in2="g" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="rg" />
      <feComposite in="rg" in2="bo" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="split" />
      <feComposite in="split" in2="SourceGraphic" operator="arithmetic" k1={0} k2={mix} k3={1 - mix} k4={0} />
    </filter>
  </svg>
);

const Grain: React.FC<{ seed: number; frame: number; grainSize: number; amount: number; chroma: number; flicker: number; width: number; height: number }> = ({ seed, frame, grainSize, amount, chroma, flicker, width, height }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.ceil(width / grainSize);
  const h = Math.ceil(height / grainSize);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(grainPixels(w, h, seed, frame, chroma)), w, h), 0, 0);
  }, [seed, frame, chroma, w, h]);
  return (
    <>
      <canvas ref={ref} width={w} height={h} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: Math.min(1, amount * 2.5), mixBlendMode: "overlay" }} />
      {flicker !== 0 ? <AbsoluteFill style={{ backgroundColor: flicker > 0 ? "#ffffff" : "#000000", opacity: Math.abs(flicker) }} /> : null}
    </>
  );
};

export const FxClip: React.FC<FxClipProps> = ({ id, file, frames, effects, width, height, inserts }) => {
  const f = useCurrentFrame();
  const layers = layersAt(effects, f, frames);
  const t = transformAt(effects, f, width, height);
  const split = rgbSplitAt(effects, f);
  const flash = flashAt(effects, f);
  const grain = grainAt(effects, f);
  // the channel offset leaves a fringe at the element edge: scale it out of view
  const splitCover = split ? 1 + 2 * Math.max(Math.abs(split.dx) / width, Math.abs(split.dy) / height) : 1;
  const filterId = `rgb-${id.replace(/[^a-z0-9]/gi, "")}`;
  const src = staticFile(file);
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000000" }}>
      {split ? <RgbSplitFilter id={filterId} dx={split.dx} dy={split.dy} mix={split.mix} /> : null}
      <AbsoluteFill style={{ transform: `translate(${t.tx}px, ${t.ty}px) rotate(${t.rotateDeg}deg) scale(${t.scale * splitCover})`, transformOrigin: `${t.originX * 100}% ${t.originY * 100}%` }}>
        <AbsoluteFill style={{ filter: [split ? `url(#${filterId})` : "", flash && flash.gain !== 1 ? `brightness(${flash.gain})` : ""].filter(Boolean).join(" ") || undefined }}>
          {layers.map((l, i) => {
            const ins = insertFrameAt(inserts, l.frame);
            return (
              <AbsoluteFill key={i} style={{ opacity: l.opacity, mixBlendMode: l.blend === "normal" ? undefined : l.blend }}>
                <Freeze frame={ins ? ins.frame : l.frame}>
                  <OffthreadVideo src={ins ? staticFile(ins.file) : src} muted style={{ width: "100%", height: "100%" }} />
                </Freeze>
              </AbsoluteFill>
            );
          })}
        </AbsoluteFill>
      </AbsoluteFill>
      {grain ? <Grain {...grain} width={width} height={height} /> : null}
      {flash && flash.color ? <AbsoluteFill style={{ backgroundColor: flash.color, opacity: flash.opacity, mixBlendMode: "screen" }} /> : null}
    </AbsoluteFill>
  );
};
