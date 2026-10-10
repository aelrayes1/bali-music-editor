/**
 * Subject-effect inserts in the Phase 6A renderer (pure and dependency-free: bundled into Remotion).
 *
 * A subject-isolated stutter is baked into an insert clip covering exactly its window. FxClip
 * shows insert frame (g - start) wherever the clean clip frame g falls inside an insert window.
 * Composition order per output frame (fixed, extends the 6A order):
 *
 *   1. subject insert (replaces the clean frame inside its window; the 6A "time remap" stage)
 *      or one 6A whole-frame time remap (never both on the same frames)
 *   2. echoTrail layers (prior frames of the timeline, inserts included)
 *   3. spatial transform (microZoom x cameraPunch)
 *   4. rgbSplit
 *   5. filmTexture
 *   6. flashFrame
 *
 * So subject stutter + rgbSplit / cameraPunch / echoTrail are well defined (the whole composed
 * frame is split / punched / echoed). Nothing combines them automatically: every effect instance
 * still comes from the edit plan or a creative style. Validation: `validateInserts` (stutter.ts).
 */

export interface SubjectInsert {
  id: string;
  /** file served next to the clip (public dir) */
  file: string;
  /** clip-local window [start, end) */
  start: number;
  end: number;
}

/** The insert frame that replaces clean clip frame g (or null: show the clean clip). */
export function insertFrameAt(inserts: readonly SubjectInsert[] | undefined, g: number): { file: string; frame: number } | null {
  for (const i of inserts ?? []) if (g >= i.start && g < i.end) return { file: i.file, frame: g - i.start };
  return null;
}
