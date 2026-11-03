// companyos-ocr: reads the text of screen frames with Apple's Vision framework, the on-device engine behind Live Text,
// and with --describe, describes image files for search: size, faces, scene labels and text.
// It makes no network calls. It is one long-lived process that reads frames from stdin and answers on stdout:
//   request:  a 4-byte big-endian length, then that many bytes of PNG
//   reply:    one JSON line, {"text": "..."} or {"error": "decode" | "recognise"}
// Lines of text come back in reading order: top to bottom, and left to right within a line. Errors carry a stage name
// only, never what was read, because the reply can reach a log. The app starts it from src/main/native-ocr.ts.
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Vision

/** Frames larger than this are refused, so a bad length cannot make the process allocate without bound. */
let maxFrameBytes = 64 * 1024 * 1024

func readExactly(_ count: Int) -> Data? {
    var data = Data(capacity: count)
    while data.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

func reply(_ object: [String: String]) {
    guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data([0x0A]))
}

/** The observations as lines of text in reading order. Vision's boxes have their origin at the bottom left. */
func readingOrder(_ observations: [VNRecognizedTextObservation]) -> String {
    let items = observations.compactMap { observation -> (box: CGRect, text: String)? in
        guard let text = observation.topCandidates(1).first?.string, !text.isEmpty else { return nil }
        return (observation.boundingBox, text)
    }
    // Rows: boxes whose vertical centres are within half a box height of each other read as one line.
    let sorted = items.sorted { $0.box.midY > $1.box.midY }
    var rows: [[(box: CGRect, text: String)]] = []
    for item in sorted {
        if let last = rows.last?.first, abs(last.box.midY - item.box.midY) < min(last.box.height, item.box.height) / 2 {
            rows[rows.count - 1].append(item)
        } else {
            rows.append([item])
        }
    }
    return rows.map { row in row.sorted { $0.box.minX < $1.box.minX }.map { $0.text }.joined(separator: " ") }.joined(separator: "\n")
}

func recognise(_ png: Data) -> [String: String] {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        return ["error": "decode"]
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        return ["error": "recognise"]
    }
    return ["text": readingOrder(request.results ?? [])]
}

/**
 * Describes one image file for search: its size as shown (orientation applied), the faces in it as boxes relative to the
 * image, Apple's scene labels with their confidence, and the start of any text in it. The file is read in a reduced size.
 */
func describe(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    // A PDF gives the text of its first pages, through PDFKit.
    if url.pathExtension.lowercased() == "pdf" {
        guard let document = PDFDocument(url: url) else { return ["path": path, "error": "decode"] }
        var text = ""
        for index in 0..<min(document.pageCount, 3) { text += (document.page(at: index)?.string ?? "") + "\n" }
        return ["path": path, "pages": document.pageCount, "text": String(text.prefix(3000))]
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          var width = properties[kCGImagePropertyPixelWidth] as? Int,
          var height = properties[kCGImagePropertyPixelHeight] as? Int else {
        return ["path": path, "error": "decode"]
    }
    if let orientation = properties[kCGImagePropertyOrientation] as? Int, orientation >= 5 { swap(&width, &height) }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1024,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        return ["path": path, "error": "decode"]
    }
    let faces = VNDetectFaceRectanglesRequest()
    let labels = VNClassifyImageRequest()
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .fast
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([faces, labels, text])
    } catch {
        return ["path": path, "error": "recognise"]
    }
    let round3 = { (value: CGFloat) in (Double(value) * 1000).rounded() / 1000 }
    let boxes = (faces.results ?? []).map { [round3($0.boundingBox.minX), round3($0.boundingBox.minY), round3($0.boundingBox.width), round3($0.boundingBox.height)] }
    let top = (labels.results ?? []).filter { $0.confidence >= 0.3 }.prefix(6).map { ["label": $0.identifier, "confidence": Double(($0.confidence * 100).rounded()) / 100] as [String: Any] }
    let words = readingOrder(text.results ?? [])
    return ["path": path, "width": width, "height": height, "faces": boxes, "labels": top, "text": String(words.prefix(300))]
}

func replyAny(_ object: [String: Any]) {
    guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data([0x0A]))
}

if CommandLine.arguments.contains("--describe") {
    // One image path per line in, one JSON line out per path.
    while let line = readLine() {
        let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.isEmpty { continue }
        autoreleasepool { replyAny(describe(path)) }
    }
} else {
    while let header = readExactly(4) {
        let length = header.reduce(0) { ($0 << 8) | Int($1) }
        guard length > 0, length <= maxFrameBytes, let png = readExactly(length) else { break }
        autoreleasepool { reply(recognise(png)) }
    }
}
