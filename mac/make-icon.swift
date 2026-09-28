// Draws the Serigraph app icon into an .iconset folder for iconutil.
// Usage: make-icon <output.iconset>
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

// The mark from app/serigraph-mark.svg: one ribbon and the same ribbon turned
// 180 degrees, in a 32 x 32 box with y pointing down.
func ribbon(_ point: (CGFloat, CGFloat) -> CGPoint) -> CGPath {
  let path = CGMutablePath()
  path.move(to: point(27.5, 3))
  path.addLine(to: point(13.5, 3))
  path.addCurve(to: point(4, 11.8), control1: point(7.8, 3), control2: point(4, 7))
  path.addCurve(to: point(10.5, 19.4), control1: point(4, 15.7), control2: point(6.4, 18))
  path.addLine(to: point(20, 22.8))
  path.addLine(to: point(20, 18.2))
  path.addLine(to: point(11.3, 15.2))
  path.addCurve(to: point(8.5, 11.8), control1: point(9.3, 14.5), control2: point(8.5, 13.5))
  path.addCurve(to: point(13.5, 7.6), control1: point(8.5, 9.5), control2: point(10.3, 7.6))
  path.addLine(to: point(22.9, 7.6))
  path.closeSubpath()
  return path
}

func draw(size: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  let cg = context.cgContext
  let s = CGFloat(size)
  // Apple's icon grid: an 824-point rounded square centered on a 1024 canvas.
  let inset = s * 100 / 1024
  let tile = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
  let radius = tile.width * 0.2237
  let shape = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

  cg.saveGState()
  cg.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.28).cgColor)
  cg.addPath(shape)
  cg.setFillColor(NSColor.white.cgColor)
  cg.fillPath()
  cg.restoreGState()

  cg.saveGState()
  cg.addPath(shape)
  cg.clip()
  let paper = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1).cgColor,
    NSColor(srgbRed: 0.925, green: 0.933, blue: 0.949, alpha: 1).cgColor,
  ] as CFArray, locations: [0, 1])!
  cg.drawLinearGradient(paper, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])

  let markSize = tile.width * 0.62
  let origin = CGPoint(x: tile.midX - markSize / 2, y: tile.midY - markSize / 2)
  let unit = markSize / 32
  let upright: (CGFloat, CGFloat) -> CGPoint = { x, y in CGPoint(x: origin.x + x * unit, y: origin.y + (32 - y) * unit) }
  let turned: (CGFloat, CGFloat) -> CGPoint = { x, y in upright(32 - x, 32 - y) }
  let ink = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    NSColor(srgbRed: 0.20, green: 0.56, blue: 1.0, alpha: 1).cgColor,
    NSColor(srgbRed: 0.0, green: 0.36, blue: 0.86, alpha: 1).cgColor,
  ] as CFArray, locations: [0, 1])!
  for path in [ribbon(upright), ribbon(turned)] {
    cg.saveGState()
    cg.addPath(path)
    cg.clip()
    cg.drawLinearGradient(ink, start: CGPoint(x: 0, y: origin.y + markSize), end: CGPoint(x: 0, y: origin.y), options: [])
    cg.restoreGState()
  }
  cg.restoreGState()

  context.flushGraphics()
  return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
  try draw(size: base).write(to: output.appendingPathComponent("icon_\(base)x\(base).png"))
  try draw(size: base * 2).write(to: output.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
