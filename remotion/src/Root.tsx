import type React from "react";
import { Composition } from "remotion";
import { CleanEdit, type CleanEditProps } from "./CleanEdit.tsx";
import { FxDemo, type FxDemoProps, FxReel, type FxReelProps } from "./fx/FxCompositions.tsx";

const defaults: CleanEditProps = { width: 1080, height: 1920, fps: 30, frames: 450, clips: [], audio: null };

const reelDefaults: FxReelProps = { width: 1080, height: 1920, fps: 30, segments: [], audio: null };
const demoDefaults: FxDemoProps = { width: 1620, height: 960, fps: 30, clipWidth: 1080, clipHeight: 1920, segments: [], audio: null };

export const Root: React.FC = () => (
  <>
  <Composition
    id="CleanEdit"
    component={CleanEdit}
    width={defaults.width}
    height={defaults.height}
    fps={defaults.fps}
    durationInFrames={defaults.frames}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({ durationInFrames: props.frames, fps: props.fps, width: props.width, height: props.height })}
  />
  <Composition id="FxReel" component={FxReel} width={1080} height={1920} fps={30} durationInFrames={1} defaultProps={reelDefaults} calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.segments.reduce((a, s) => a + s.frames, 0)), fps: props.fps, width: props.width, height: props.height })} />
  <Composition id="FxDemo" component={FxDemo} width={1620} height={960} fps={30} durationInFrames={1} defaultProps={demoDefaults} calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.segments.reduce((a, s) => a + s.frames, 0)), fps: props.fps, width: props.width, height: props.height })} />
  </>
);
