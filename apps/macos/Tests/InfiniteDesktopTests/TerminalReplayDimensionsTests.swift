import XCTest
import InfiniteCore
@testable import InfiniteDesktop

@MainActor final class TerminalReplayDimensionsTests: XCTestCase {
    private struct FeedRecord: Equatable {
        let data: Data
        let reset: Bool
        let columns: Int?
        let rows: Int?
    }

    private func makeModel() -> SessionModel {
        let profile = HostProfile(id: "profile-a", label: "A", origin: "https://a.example.com")
        let client = RemoteClient(profile: profile, token: "token-a")
        let session = AgentSession(value: .object(["id": .string("sess-1"), "status": .string("running")]))
        let deps = SessionModelDependencies(
            readDraft: { _ in DraftRecord() },
            saveDraft: { _, _ in },
            acquireMutation: { _, _ in DraftRecord() },
            clearDraftIfMatching: { _, _ in },
            sendRequest: { _, _, _, _ in .object([:]) },
            openTerminal: { _, _, _ in "stream-1" },
            closeTerminal: { _, _ in },
            sendTerminal: { _, _, _ in }
        )
        return SessionModel(session: session, client: client, profileID: "profile-a", role: "owner", supportsStream: true, deps: deps)
    }

    func testTerminalDimensionsValidatesIntegerBoundsAndRejectsInvalidValues() throws {
        let parsedCols = try XCTUnwrap(TerminalDimensions(json: .object(["cols": .number(120), "rows": .number(32)])))
        XCTAssertEqual(parsedCols.columns, 120)
        XCTAssertEqual(parsedCols.rows, 32)
        XCTAssertEqual(TerminalDimensions(columns: 120, rows: 32), parsedCols)
        let parsedColumns = try XCTUnwrap(TerminalDimensions(json: .object(["columns": .number(96), "rows": .number(28)])))
        XCTAssertEqual(TerminalDimensions(columns: 96, rows: 28), parsedColumns)
        XCTAssertNil(TerminalDimensions(columns: 0, rows: 24))
        XCTAssertNil(TerminalDimensions(columns: 1001, rows: 24))
        XCTAssertNil(TerminalDimensions(columns: 80, rows: nil))
        XCTAssertNil(TerminalDimensions(json: .object(["cols": .number(80.5), "rows": .number(24)])))
        XCTAssertNil(TerminalDimensions(json: .object(["cols": .string("80"), "rows": .number(24)])))
        XCTAssertNil(TerminalDimensions(json: .null))
    }

    func testSessionModelForwardsOpenAndNonSnapshotReplayDimensionsAndReplaysInOrder() {
        let model = makeModel()
        var live: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            live.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }

        model.receive(.object(["message": .object([
            "open": .object(["cursor": .number(0), "cols": .number(120), "rows": .number(32)]),
            "cursor": .number(0),
            "cols": .number(120),
            "rows": .number(32),
        ])]))
        XCTAssertTrue(model.rendererState.snapshotReady)
        model.receive(.object(["message": .object([
            "events": .array([.object(["seq": .number(1), "type": .string("output"), "data": .object(["text": .string("WIDE\r\n")])])]),
            "cursor": .number(1),
            "cols": .number(120),
            "rows": .number(32),
        ])]))
        model.receive(.object(["message": .object([
            "events": .array([.object(["seq": .number(2), "type": .string("lifecycle"), "data": .object(["event": .string("resize"), "cols": .number(88), "rows": .number(26)])])]),
            "cursor": .number(2),
            "cols": .number(88),
            "rows": .number(26),
        ])]))
        model.receive(.object(["message": .object([
            "events": .array([.object(["seq": .number(3), "type": .string("output"), "data": .object(["text": .string("NARROW\r\n")])])]),
            "cursor": .number(3),
            "cols": .number(88),
            "rows": .number(26),
        ])]))

        XCTAssertEqual(live, [
            FeedRecord(data: Data(), reset: true, columns: 120, rows: 32),
            FeedRecord(data: Data("WIDE\r\n".utf8), reset: false, columns: 120, rows: 32),
            FeedRecord(data: Data(), reset: false, columns: 88, rows: 26),
            FeedRecord(data: Data("NARROW\r\n".utf8), reset: false, columns: 88, rows: 26),
        ])

        var replayed: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            replayed.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }
        XCTAssertTrue(model.pipe.replay())
        XCTAssertEqual(replayed, [
            FeedRecord(data: Data("WIDE\r\n".utf8), reset: true, columns: 120, rows: 32),
            FeedRecord(data: Data("NARROW\r\n".utf8), reset: false, columns: 88, rows: 26),
        ])
    }

    func testSessionModelForwardsPostSnapshotLifecycleResizesInBatchedFramesWithoutLeakingStaleDimensions() {
        let model = makeModel()
        var live: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            live.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }

        model.receive(.object(["message": .object([
            "open": .object(["cursor": .number(10), "cols": .number(120), "rows": .number(32)]),
            "snapshot": .object(["ansi": .string("SNAP"), "seq": .number(10), "cols": .number(120), "rows": .number(32)]),
            "cursor": .number(10),
            "cols": .number(120),
            "rows": .number(32),
        ])]))
        model.receive(.object(["message": .object([
            "events": .array([
                .object(["seq": .number(11), "type": .string("output"), "data": .object(["text": .string("AT_120")])]),
                .object(["seq": .number(12), "type": .string("lifecycle"), "data": .object(["event": .string("resize"), "cols": .number(92), "rows": .number(27)])]),
                .object(["seq": .number(13), "type": .string("output"), "data": .object(["text": .string("AT_92")])]),
            ]),
            "cursor": .number(13),
            "cols": .number(92),
            "rows": .number(27),
        ])]))

        XCTAssertEqual(live, [
            FeedRecord(data: Data("SNAP".utf8), reset: true, columns: 120, rows: 32),
            FeedRecord(data: Data("AT_120".utf8), reset: false, columns: nil, rows: nil),
            FeedRecord(data: Data(), reset: false, columns: 92, rows: 27),
            FeedRecord(data: Data("AT_92".utf8), reset: false, columns: nil, rows: nil),
        ])

        var replayed: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            replayed.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }
        XCTAssertTrue(model.pipe.replay())
        XCTAssertEqual(replayed, [
            FeedRecord(data: Data("SNAPAT_120".utf8), reset: true, columns: 120, rows: 32),
            FeedRecord(data: Data("AT_92".utf8), reset: false, columns: 92, rows: 27),
        ])
    }

    func testSessionModelAppliesStateTerminalSizeOnlyAsFallbackBeforeAuthoritativeSize() {
        let model = makeModel()
        var live: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            live.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }

        model.pipe.feed(Data(), reset: true)
        model.receive(.object(["message": .object([
            "state": .object(["status": .string("running"), "terminalSize": .object(["cols": .number(110), "rows": .number(35)])]),
        ])]))
        model.receive(.object(["message": .object([
            "events": .array([.object(["seq": .number(1), "type": .string("output"), "data": .object(["text": .string("FIRST")])])]),
        ])]))
        model.receive(.object(["message": .object([
            "state": .object(["status": .string("running"), "terminalSize": .object(["cols": .number(80), "rows": .number(24)])]),
        ])]))

        XCTAssertEqual(model.pipe.activeDimensions, TerminalDimensions(columns: 110, rows: 35))
        XCTAssertEqual(live, [
            FeedRecord(data: Data(), reset: true, columns: nil, rows: nil),
            FeedRecord(data: Data(), reset: false, columns: 110, rows: 35),
            FeedRecord(data: Data("FIRST".utf8), reset: true, columns: 110, rows: 35),
        ])

        var replayed: [FeedRecord] = []
        model.pipe.receive = { data, reset, cols, rows in
            replayed.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }
        XCTAssertTrue(model.pipe.replay())
        XCTAssertEqual(replayed, [FeedRecord(data: Data("FIRST".utf8), reset: true, columns: 110, rows: 35)])
    }

    func testTerminalPipePreservesActiveDimensionsAcrossHistoryOverflowAndRecoversOnReset() {
        let pipe = TerminalPipe()
        pipe.feed(Data("init".utf8), reset: true, columns: 120, rows: 32)
        let oversized = Data(repeating: 0x41, count: TerminalPipe.maxHistoryBytes)
        pipe.feed(oversized, reset: false, columns: 96, rows: 28)

        XCTAssertEqual(pipe.activeDimensions, TerminalDimensions(columns: 96, rows: 28))
        XCTAssertFalse(pipe.replay())

        pipe.feed(Data("fresh".utf8), reset: true, columns: 104, rows: 40)
        var replayed: [FeedRecord] = []
        pipe.receive = { data, reset, cols, rows in
            replayed.append(FeedRecord(data: data, reset: reset, columns: cols, rows: rows))
        }
        XCTAssertTrue(pipe.replay())
        XCTAssertEqual(pipe.activeDimensions, TerminalDimensions(columns: 104, rows: 40))
        XCTAssertEqual(replayed, [FeedRecord(data: Data("fresh".utf8), reset: true, columns: 104, rows: 40)])
    }

    func testTerminalFeedQueuePreservesOrderedResizeTransitionsAndPreventsStaleResetDimensions() throws {
        var queue = TerminalFeedQueue()
        let size120 = try XCTUnwrap(TerminalDimensions(columns: 120, rows: 32))
        let size88 = try XCTUnwrap(TerminalDimensions(columns: 88, rows: 26))
        let size100 = try XCTUnwrap(TerminalDimensions(columns: 100, rows: 40))

        XCTAssertTrue(queue.enqueue(data: Data("A".utf8), reset: true, dimensions: size120))
        XCTAssertTrue(queue.enqueue(data: Data("B".utf8), reset: false, dimensions: nil))
        XCTAssertTrue(queue.enqueue(data: Data(), reset: false, dimensions: size88))
        XCTAssertTrue(queue.enqueue(data: Data("C".utf8), reset: false, dimensions: size88))
        XCTAssertTrue(queue.enqueue(data: Data(), reset: false, dimensions: size100))

        XCTAssertEqual(queue.dequeue(), TerminalFeedStep(data: Data("AB".utf8), reset: true, dimensions: size120))
        XCTAssertEqual(queue.dequeue(), TerminalFeedStep(data: Data("C".utf8), reset: false, dimensions: size88))
        XCTAssertEqual(queue.dequeue(), TerminalFeedStep(data: Data(), reset: false, dimensions: size100))
        XCTAssertNil(queue.dequeue())

        XCTAssertTrue(queue.enqueue(data: Data("LIVE".utf8), reset: false, dimensions: nil))
        XCTAssertEqual(queue.dequeue(), TerminalFeedStep(data: Data("LIVE".utf8), reset: false, dimensions: nil))
        XCTAssertNil(queue.dequeue())

        let oversized = Data(repeating: 0x42, count: TerminalFeedQueue.maxPendingBytes + 1)
        XCTAssertFalse(queue.enqueue(data: oversized, reset: false, dimensions: size88))
        XCTAssertTrue(queue.overflowed)
        let pauseStep = try XCTUnwrap(queue.dequeue())
        XCTAssertTrue(pauseStep.reset)
        XCTAssertNil(pauseStep.dimensions)
        XCTAssertTrue(queue.enqueue(data: Data("dropped".utf8), reset: false, dimensions: size100))
        XCTAssertNil(queue.dequeue())
        XCTAssertTrue(queue.enqueue(data: Data("RECOVERED".utf8), reset: true, dimensions: size100))
        XCTAssertFalse(queue.overflowed)
        XCTAssertEqual(queue.dequeue(), TerminalFeedStep(data: Data("RECOVERED".utf8), reset: true, dimensions: size100))
    }
}
