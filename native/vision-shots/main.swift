// vision-shots: local, on-device image understanding for Phase 3B (Apple Vision framework only;
// no downloaded models, no network). Reads a JSON job on stdin, writes one JSON result per image
// (JSON Lines) to stdout. All requests run CPU-only for run-to-run determinism.
//
// Job:    {"images":[{"id":"...","path":"/abs/frame.jpg","crop":{"x","y","w","h"}?}]}  (crop in image pixels)
// Result: {"id","width","height","humans":[box],"faces":[box+yaw/roll/pitch],"bodies":[{conf,joints}],
//          "labels":[{id,conf}],"saliency":[box],"text":[box],"featurePrint":"<base64 float32>"}
// Boxes are normalized to the image, origin TOP-left: {x,y,w,h,conf}.

import CoreML
import Foundation
import Vision

struct Job: Decodable { let images: [Item] }
struct Crop: Decodable { let x: Int; let y: Int; let w: Int; let h: Int }
struct Item: Decodable { let id: String; let path: String; let crop: Crop? }

func box(_ r: CGRect, _ conf: Float) -> [String: Any] {
  let q = { (v: CGFloat) -> Double in (Double(v) * 10000).rounded() / 10000 }
  return ["x": q(r.minX), "y": q(1 - r.maxY), "w": q(r.width), "h": q(r.height), "conf": (Double(conf) * 1000).rounded() / 1000]
}

func cpuOnly(_ r: VNRequest) {
  if #available(macOS 14.0, *) {
    if let stages = try? r.supportedComputeStageDevices {
      for (stage, devices) in stages {
        if let cpu = devices.first(where: { if case .cpu = $0 { return true } else { return false } }) {
          r.setComputeDevice(cpu, for: stage)
        }
      }
    }
  } else {
    r.usesCPUOnly = true
  }
}

let data = FileHandle.standardInput.readDataToEndOfFile()
let job = try JSONDecoder().decode(Job.self, from: data)
let jointNames: [VNHumanBodyPoseObservation.JointName] = [
  .nose, .neck, .leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist,
  .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle, .leftEye, .rightEye, .leftEar, .rightEar,
]

for item in job.images {
  var out: [String: Any] = ["id": item.id]
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: item.path) as CFURL, nil),
        let full = CGImageSourceCreateImageAtIndex(src, 0, nil),
        let img = item.crop.map({ full.cropping(to: CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h)) }) ?? full else {
    out["error"] = "cannot read image"
    print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
    continue
  }
  out["width"] = img.width
  out["height"] = img.height
  let humans = VNDetectHumanRectanglesRequest()
  humans.upperBodyOnly = false
  let faces = VNDetectFaceRectanglesRequest()
  let bodies = VNDetectHumanBodyPoseRequest()
  let classify = VNClassifyImageRequest()
  let saliency = VNGenerateAttentionBasedSaliencyImageRequest()
  let text = VNDetectTextRectanglesRequest()
  let print_ = VNGenerateImageFeaturePrintRequest()
  let all: [VNRequest] = [humans, faces, bodies, classify, saliency, text, print_]
  all.forEach(cpuOnly)
  let handler = VNImageRequestHandler(cgImage: img, options: [:])
  do {
    try handler.perform(all)
  } catch {
    out["error"] = "\(error)"
  }
  out["humans"] = (humans.results ?? []).map { box($0.boundingBox, $0.confidence) }
  out["faces"] = (faces.results ?? []).map { f -> [String: Any] in
    var b = box(f.boundingBox, f.confidence)
    let deg = { (n: NSNumber?) -> Any in n.map { ($0.doubleValue * 180 / .pi * 10).rounded() / 10 } ?? NSNull() }
    b["yaw"] = deg(f.yaw)
    b["roll"] = deg(f.roll)
    b["pitch"] = deg(f.pitch)
    return b
  }
  out["bodies"] = (bodies.results ?? []).map { o -> [String: Any] in
    var joints: [String: [Double]] = [:]
    for n in jointNames {
      if let p = try? o.recognizedPoint(n), p.confidence > 0.1 {
        joints[n.rawValue.rawValue] = [(Double(p.location.x) * 10000).rounded() / 10000, (Double(1 - p.location.y) * 10000).rounded() / 10000, (Double(p.confidence) * 1000).rounded() / 1000]
      }
    }
    return ["conf": (Double(o.confidence) * 1000).rounded() / 1000, "joints": joints]
  }
  out["labels"] = (classify.results ?? []).filter { $0.confidence >= 0.05 }.sorted { $0.confidence > $1.confidence }.prefix(20).map {
    ["id": $0.identifier, "conf": (Double($0.confidence) * 1000).rounded() / 1000] as [String: Any]
  }
  out["saliency"] = ((saliency.results?.first)?.salientObjects ?? []).map { box($0.boundingBox, $0.confidence) }
  out["text"] = (text.results ?? []).map { box($0.boundingBox, $0.confidence) }
  if let fp = print_.results?.first, fp.elementType == .float {
    out["featurePrint"] = fp.data.base64EncodedString()
    out["featurePrintCount"] = fp.elementCount
  }
  print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
}
