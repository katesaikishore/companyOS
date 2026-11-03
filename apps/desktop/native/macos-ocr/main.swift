// companyos-ocr: reads the text of screen frames with Apple's Vision framework, the on-device engine behind Live Text.
// It makes no network calls. It is one long-lived process that reads frames from stdin and answers on stdout:
//   request:  a 4-byte big-endian length, then that many bytes of PNG
//   reply:    one JSON line, {"text": "..."} or {"error": "decode" | "recognise"}
// Lines of text come back in reading order: top to bottom, and left to right within a line. Errors carry a stage name
// only, never what was read, because the reply can reach a log. The app starts it from src/main/native-ocr.ts.
import CoreGraphics
import Foundation
import ImageIO
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

while let header = readExactly(4) {
    let length = header.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maxFrameBytes, let png = readExactly(length) else { break }
    autoreleasepool { reply(recognise(png)) }
}
