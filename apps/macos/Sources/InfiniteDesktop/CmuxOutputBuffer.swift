import Foundation
import InfiniteCore

final class CmuxOutputBuffer: Sendable {
    private static let maximumBufferedEvents = 512
    private static let maximumBufferedBytes: Int64 = 16 * 1024 * 1024
    private let continuation: AsyncStream<CmuxTerminalOutput>.Continuation
    private let queuedEvents = LockFreeInt64(0)
    private let queuedBytes = LockFreeInt64(0)
    private let overflowed = LockFreeInt64(0)
    private let canceled = LockFreeInt64(0)
    private let consumer: Task<Void, Never>

    init(deliver: @escaping @MainActor @Sendable ([CmuxTerminalOutput]) -> Void) {
        let (stream, continuation) = AsyncStream.makeStream(
            of: CmuxTerminalOutput.self,
            bufferingPolicy: .bufferingOldest(Self.maximumBufferedEvents + 1)
        )
        self.continuation = continuation
        let queuedEvents = self.queuedEvents
        let queuedBytes = self.queuedBytes
        let overflowed = self.overflowed
        let canceled = self.canceled
        self.consumer = Task { @MainActor in
            var batch: [CmuxTerminalOutput] = []
            var batchBytes: Int64 = 0
            var flushTask: Task<Void, Never>?
            var deliveredOverflow = false
            @MainActor func discardBatch() {
                let bytes = batchBytes
                let count = Int64(batch.count)
                batch.removeAll()
                batchBytes = 0
                if bytes > 0 { queuedBytes.sub(bytes) }
                if count > 0 { queuedEvents.sub(count) }
            }
            @MainActor func flushBatch() {
                guard !batch.isEmpty else { return }
                let out = batch
                let bytes = batchBytes
                let count = Int64(out.count)
                batch.removeAll()
                batchBytes = 0
                deliver(out)
                if bytes > 0 { queuedBytes.sub(bytes) }
                if count > 0 { queuedEvents.sub(count) }
            }
            @MainActor func deliverOverflowOnce() {
                guard !deliveredOverflow, !Task.isCancelled, canceled.load() == 0 else { return }
                deliveredOverflow = true
                discardBatch()
                flushTask?.cancel()
                flushTask = nil
                continuation.finish()
                deliver([.invalidFrame])
            }
            defer {
                flushTask?.cancel()
                discardBatch()
            }
            for await event in stream {
                if Task.isCancelled || canceled.load() != 0 {
                    let size = Self.byteSize(of: event)
                    if size > 0 { queuedBytes.sub(size) }
                    queuedEvents.sub(1)
                    break
                }
                if overflowed.load() != 0 {
                    let size = Self.byteSize(of: event)
                    if size > 0 { queuedBytes.sub(size) }
                    queuedEvents.sub(1)
                    deliverOverflowOnce()
                    return
                }
                batch.append(event)
                batchBytes += Self.byteSize(of: event)
                if flushTask == nil {
                    flushTask = Task { @MainActor in
                        await Task.yield()
                        flushTask = nil
                        guard !Task.isCancelled, canceled.load() == 0 else { return }
                        if overflowed.load() != 0 {
                            deliverOverflowOnce()
                            return
                        }
                        flushBatch()
                    }
                }
            }
            if Task.isCancelled || canceled.load() != 0 { return }
            flushTask?.cancel()
            flushTask = nil
            if overflowed.load() != 0 {
                deliverOverflowOnce()
            } else {
                flushBatch()
            }
        }
    }

    func append(_ event: CmuxTerminalOutput) {
        guard canceled.load() == 0, overflowed.load() == 0 else { return }
        let size = Self.byteSize(of: event)
        if queuedEvents.add(1) > Int64(Self.maximumBufferedEvents) {
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
            return
        }
        if queuedBytes.add(size) > Self.maximumBufferedBytes {
            queuedBytes.sub(size)
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
            return
        }
        if case .dropped = continuation.yield(event) {
            queuedBytes.sub(size)
            queuedEvents.sub(1)
            overflowed.store(1)
            continuation.finish()
        }
    }

    func cancel() {
        canceled.store(1)
        continuation.finish()
        consumer.cancel()
    }

    deinit {
        canceled.store(1)
        continuation.finish()
        consumer.cancel()
    }

    private static func byteSize(of event: CmuxTerminalOutput) -> Int64 {
        switch event {
        case .snapshot(let bytes, _, _), .bytes(let bytes): return Int64(bytes.count)
        default: return 0
        }
    }
}
