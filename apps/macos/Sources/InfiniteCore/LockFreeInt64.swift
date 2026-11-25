import Foundation
import InfiniteAtomics

public final class LockFreeInt64: @unchecked Sendable {
    private let storage: UnsafeMutablePointer<infinite_atomic_int64>

    public init(_ initial: Int64 = 0) {
        storage = .allocate(capacity: 1)
        infinite_atomic_init(storage, initial)
    }

    deinit {
        storage.deallocate()
    }

    public func load() -> Int64 { infinite_atomic_load(storage) }
    public func store(_ value: Int64) { infinite_atomic_store(storage, value) }
    @discardableResult public func add(_ delta: Int64) -> Int64 { infinite_atomic_fetch_add(storage, delta) + delta }
    @discardableResult public func sub(_ delta: Int64) -> Int64 { infinite_atomic_fetch_sub(storage, delta) - delta }
}
