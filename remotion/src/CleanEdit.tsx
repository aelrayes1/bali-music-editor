/**
 * Clean edit composition: places the conformed, already-reframed clips of an approved Edit Plan on
 * the timeline at the plan's render frames and plays the untouched song window underneath.
 * It makes no creative decisions: no transitions, no effects, no timing changes.
 */

import type React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile } from "remotion";

export interface CleanEditClip {
  clipId: string;
  /** file in the public dir: 1080x1920, 30 fps CFR, exactly durationInFrames frames */
  file: string;
  from: number;
  durationInFrames: number;
}

export interface CleanEditProps extends Record<string, unknown> {
  width: number;
  height: number;
  fps: number;
  frames: number;
  clips: CleanEditClip[];
  audio: { file: string } | null;
}

export const CleanEdit: React.FC<CleanEditProps> = ({ clips, audio }) => (
  <AbsoluteFill style={{ backgroundColor: "#000000" }}>
    {clips.map((c) => (
      <Sequence key={c.clipId} name={c.clipId} from={c.from} durationInFrames={c.durationInFrames}>
        <OffthreadVideo src={staticFile(c.file)} muted style={{ width: "100%", height: "100%" }} />
      </Sequence>
    ))}
    {audio ? <Audio src={staticFile(audio.file)} /> : null}
  </AbsoluteFill>
);
