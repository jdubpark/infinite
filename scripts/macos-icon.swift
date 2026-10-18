import AppKit
let side: CGFloat = 1024
let image = NSImage(size: NSSize(width: side, height: side))
image.lockFocus()
NSColor(red: 0.12, green: 0.27, blue: 0.22, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 20, y: 20, width: 984, height: 984), xRadius: 210, yRadius: 210).fill()
let mark = NSBezierPath()
mark.move(to: NSPoint(x: 512, y: 512))
mark.curve(to: NSPoint(x: 200, y: 512), controlPoint1: NSPoint(x: 320, y: 780), controlPoint2: NSPoint(x: 200, y: 692))
mark.curve(to: NSPoint(x: 512, y: 512), controlPoint1: NSPoint(x: 200, y: 332), controlPoint2: NSPoint(x: 320, y: 244))
mark.curve(to: NSPoint(x: 824, y: 512), controlPoint1: NSPoint(x: 704, y: 780), controlPoint2: NSPoint(x: 824, y: 692))
mark.curve(to: NSPoint(x: 512, y: 512), controlPoint1: NSPoint(x: 824, y: 332), controlPoint2: NSPoint(x: 704, y: 244))
mark.lineWidth = 64; mark.lineCapStyle = .round; mark.lineJoinStyle = .round
NSColor(red: 0.93, green: 0.93, blue: 0.86, alpha: 1).setStroke(); mark.stroke()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
