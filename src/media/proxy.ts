/**
 * Proxy / working-copy contracts (interfaces only in Phase 1).
 *
 * Rules:
 *  - Originals stay authoritative. A proxy never replaces an original path in the manifest.
 *  - Every proxy records the source mediaId and the source content fingerprint it was made
 *    from; a changed source invalidates the proxy.
 *  - Proxies are reproducible: the exact tool version and argument list are recorded.
 *  - Render/QC code must state whether it used an original or a proxy (v5 Phase 9 checks
 *    "source/proxy mix-ups").
 */

import type { RationalJson } from "./schema.ts";

export type ProxyPurpose = "preview" | "analysis" | "edit";

export interface ProxyProfile {
  readonly id: string; // e.g. "preview-720p-h264"
  readonly purpose: ProxyPurpose;
  readonly maxLongEdge: number;
  readonly videoCodec: string;
  readonly quality: string; // encoder-specific, recorded verbatim
  /** Keep source timing: no frame-rate conversion, VFR preserved unless stated. */
  readonly preserveTiming: true;
  /** Rotation is baked into pixels for proxies (display orientation), recorded here. */
  readonly bakeRotation: boolean;
}

export interface ProxyRecord {
  readonly proxyId: string;
  readonly sourceMediaId: string;
  readonly sourceFingerprint: string;
  readonly profileId: string;
  readonly path: string;
  readonly createdWith: { readonly tool: string; readonly version: string; readonly args: readonly string[] };
  readonly durationSeconds: RationalJson | null;
  readonly frameCount: number | null;
  readonly verifiedAgainstSource: boolean;
}
