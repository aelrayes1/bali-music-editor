// subject-masks: local, on-device person masks for Phase 6B (Apple Vision framework only; no
// downloaded models, no network). Reads a JSON job on stdin, writes one JSON result per frame
// (JSON Lines) to stdout and the masks as 8-bit gray PNGs. All requests run CPU-only for
// run-to-run determinism.
//
// Job:    {"outDir":"/abs","downscale":4,"segmentation":false,
//          "frames":[{"id":"f0000","path":"/abs/frame.png"}]}
// Result: {"id","width","height","maskWidth","maskHeight",
//          "instances":[{"index","file","area","bbox":{x,y,w,h}}],
//          "faces":[{x,y,w,h,conf,"coverage":[per instance, same order]}],
//          "segmentation":"file"|null, "error"?}
// Instance masks come from VNGeneratePersonInstanceMaskRequest (up to 4 people, each separable);
// the optional whole-person matte from VNGeneratePersonSegmentationRequest (accurate) is a
// fallback when no instance is found. Boxes are normalized, origin TOP-left. Mask pixel values are
// the mask's soft coverage (0-255), box-averaged down by `downscale`.

import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Job: Decodable {
  let outDir: String
  let downscale: Int
  let segmentation: Bool?
  let frames: [Frame]
}
struct Frame: Decodable { let id: String; let path: String }

func cpuOnly(_ r: VNRequest) {
  if let stages = try? r.supportedComputeStageDevices {
    for (stage, devices) in stages {
      if let cpu = devices.first(where: { if case .cpu = $0 { return true } else { return false } }) {
        r.setComputeDevice(cpu, for: stage)
      }
    }
  }
}

/// Box-average a mask pixel buffer (8-bit or 32-bit float, any size) to `ow` x `oh` bytes.
func downsample(_ pb: CVPixelBuffer, _ ow: Int, _ oh: Int) -> [UInt8] {
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
  let w = CVPixelBufferGetWidth(pb)
  let h = CVPixelBufferGetHeight(pb)
  let row = CVPixelBufferGetBytesPerRow(pb)
  let base = CVPixelBufferGetBaseAddress(pb)!
  let fmt = CVPixelBufferGetPixelFormatType(pb)
  let isFloat = fmt == kCVPixelFormatType_OneComponent32Float
  var out = [UInt8](repeating: 0, count: ow * oh)
  for oy in 0..<oh {
    let y0 = oy * h / oh
    let y1 = max(y0 + 1, (oy + 1) * h / oh)
    for ox in 0..<ow {
      let x0 = ox * w / ow
      let x1 = max(x0 + 1, (ox + 1) * w / ow)
      var s = 0.0
      for y in y0..<y1 {
        let r = base.advanced(by: y * row)
        if isFloat {
          let p = r.assumingMemoryBound(to: Float32.self)
          for x in x0..<x1 { s += Double(min(1, max(0, p[x]))) }
        } else {
          let p = r.assumingMemoryBound(to: UInt8.self)
          for x in x0..<x1 { s += Double(p[x]) / 255 }
        }
      }
      out[oy * ow + ox] = UInt8((s / Double((y1 - y0) * (x1 - x0)) * 255).rounded())
    }
  }
  return out
}

func writeGray(_ px: [UInt8], _ w: Int, _ h: Int, _ path: String) throws {
  let data = Data(px) as CFData
  let img = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: CGDataProvider(data: data)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, img, nil)
  if !CGImageDestinationFinalize(dest) { throw NSError(domain: "subject-masks", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot write \(path)"]) }
}

let q4 = { (v: Double) -> Double in (v * 10000).rounded() / 10000 }
let data = FileHandle.standardInput.readDataToEndOfFile()
let job = try JSONDecoder().decode(Job.self, from: data)
try FileManager.default.createDirectory(atPath: job.outDir, withIntermediateDirectories: true)

for fr in job.frames {
  var out: [String: Any] = ["id": fr.id]
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: fr.path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    out["error"] = "cannot read image"
    print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
    continue
  }
  let W = img.width
  let H = img.height
  let mw = W / job.downscale
  let mh = H / job.downscale
  out["width"] = W
  out["height"] = H
  out["maskWidth"] = mw
  out["maskHeight"] = mh
  let inst = VNGeneratePersonInstanceMaskRequest()
  let faces = VNDetectFaceRectanglesRequest()
  let reqs: [VNRequest] = [inst, faces]
  reqs.forEach(cpuOnly)
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  var masks: [[UInt8]] = []
  do {
    try handler.perform(reqs)
    var list: [[String: Any]] = []
    if let obs = inst.results?.first {
      for i in obs.allInstances.sorted() {
        let pb = try obs.generateScaledMaskForImage(forInstances: IndexSet(integer: i), from: handler)
        let m = downsample(pb, mw, mh)
        let file = "\(fr.id)-i\(i).png"
        try writeGray(m, mw, mh, "\(job.outDir)/\(file)")
        var area = 0.0
        var x0 = mw, y0 = mh, x1 = -1, y1 = -1
        for y in 0..<mh {
          for x in 0..<mw where m[y * mw + x] >= 128 {
            area += 1
            x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y)
          }
        }
        let bbox: Any = x1 < 0 ? NSNull() : ["x": q4(Double(x0) / Double(mw)), "y": q4(Double(y0) / Double(mh)), "w": q4(Double(x1 - x0 + 1) / Double(mw)), "h": q4(Double(y1 - y0 + 1) / Double(mh))]
        list.append(["index": i, "file": file, "area": q4(area / Double(mw * mh)), "bbox": bbox])
        masks.append(m)
      }
    }
    out["instances"] = list
  } catch {
    out["error"] = "\(error)"
    out["instances"] = [] as [Any]
  }
  out["faces"] = (faces.results ?? []).map { f -> [String: Any] in
    let r = f.boundingBox
    let fx0 = max(0, Int(Double(r.minX) * Double(mw))), fx1 = min(mw, Int((Double(r.maxX) * Double(mw)).rounded(.up)))
    let fy0 = max(0, Int(Double(1 - r.maxY) * Double(mh))), fy1 = min(mh, Int((Double(1 - r.minY) * Double(mh)).rounded(.up)))
    let cov = masks.map { m -> Double in
      var n = 0, s = 0
      for y in fy0..<max(fy0, fy1) { for x in fx0..<max(fx0, fx1) { n += 1; if m[y * mw + x] >= 128 { s += 1 } } }
      return n == 0 ? 0 : q4(Double(s) / Double(n))
    }
    return ["x": q4(Double(r.minX)), "y": q4(Double(1 - r.maxY)), "w": q4(Double(r.width)), "h": q4(Double(r.height)), "conf": (Double(f.confidence) * 1000).rounded() / 1000, "coverage": cov]
  }
  out["segmentation"] = NSNull()
  if job.segmentation == true || masks.isEmpty {
    let seg = VNGeneratePersonSegmentationRequest()
    seg.qualityLevel = .accurate
    seg.outputPixelFormat = kCVPixelFormatType_OneComponent8
    cpuOnly(seg)
    if (try? handler.perform([seg])) != nil, let pb = seg.results?.first?.pixelBuffer {
      let file = "\(fr.id)-seg.png"
      try writeGray(downsample(pb, mw, mh), mw, mh, "\(job.outDir)/\(file)")
      out["segmentation"] = file
    }
  }
  print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
}
