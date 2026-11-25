import XCTest
import InfiniteCore
@testable import InfiniteDesktop

final class CmuxOutputBufferTests: XCTestCase {
    @MainActor func testDeliversBufferedEventsInOrder() async throws {
        var received: [Data] = []
        let buffer = CmuxOutputBuffer { events in
            for event in events {
                if case .bytes(let data) = event {
                    received.append(data)
                }
            }
        }
        defer { buffer.cancel() }

        buffer.append(.bytes(Data("first".utf8)))
        buffer.append(.bytes(Data("second".utf8)))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(received, [Data("first".utf8), Data("second".utf8)])
    }

    @MainActor func testCountOverflowDeliversInvalidFrameAndDropsStaleEvents() async throws {
        var invalidCount = 0
        var byteEventCount = 0
        let buffer = CmuxOutputBuffer { events in
            for event in events {
                switch event {
                case .invalidFrame: invalidCount += 1
                case .bytes: byteEventCount += 1
                default: break
                }
            }
        }
        defer { buffer.cancel() }

        for index in 0..<520 {
            buffer.append(.bytes(Data([UInt8(index & 0xff)])))
        }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(invalidCount, 1)
        XCTAssertEqual(byteEventCount, 0)

        buffer.append(.bytes(Data("after".utf8)))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(invalidCount, 1)
        XCTAssertEqual(byteEventCount, 0)
    }

    @MainActor func testByteOverflowDeliversInvalidFrameAndTerminatesStream() async throws {
        var invalidCount = 0
        var byteEventCount = 0
        let buffer = CmuxOutputBuffer { events in
            for event in events {
                switch event {
                case .invalidFrame: invalidCount += 1
                case .bytes: byteEventCount += 1
                default: break
                }
            }
        }
        defer { buffer.cancel() }

        let chunk = Data(repeating: 65, count: 9 * 1024 * 1024)
        buffer.append(.bytes(chunk))
        await Task.yield()
        buffer.append(.bytes(chunk))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(invalidCount, 1)
        XCTAssertEqual(byteEventCount, 0)

        buffer.append(.bytes(Data("after".utf8)))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(invalidCount, 1)
        XCTAssertEqual(byteEventCount, 0)
    }

    @MainActor func testReleasesBudgetOnlyAfterPendingFlushCompletes() async throws {
        var invalidCount = 0
        var byteEventCount = 0
        let buffer = CmuxOutputBuffer { events in
            for event in events {
                switch event {
                case .invalidFrame: invalidCount += 1
                case .bytes: byteEventCount += 1
                default: break
                }
            }
        }
        defer { buffer.cancel() }

        let chunk = Data(repeating: 65, count: 9 * 1024 * 1024)
        buffer.append(.bytes(chunk))
        try await Task.sleep(for: .milliseconds(50))
        buffer.append(.bytes(chunk))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(invalidCount, 0)
        XCTAssertEqual(byteEventCount, 2)
    }

    @MainActor func testCancelSuppressesPendingDelivery() async throws {
        var deliveredCount = 0
        let buffer = CmuxOutputBuffer { events in
            deliveredCount += events.count
        }
        buffer.append(.bytes(Data("pending".utf8)))
        buffer.cancel()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(deliveredCount, 0)
    }
}
