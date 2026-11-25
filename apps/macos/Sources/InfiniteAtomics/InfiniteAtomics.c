#include "InfiniteAtomics.h"
#include <stdatomic.h>

void infinite_atomic_init(infinite_atomic_int64 *target, int64_t initial) {
    atomic_init(&target->value, initial);
}

int64_t infinite_atomic_load(const infinite_atomic_int64 *target) {
    return atomic_load_explicit((_Atomic int64_t *)&target->value, memory_order_acquire);
}

void infinite_atomic_store(infinite_atomic_int64 *target, int64_t value) {
    atomic_store_explicit(&target->value, value, memory_order_release);
}

int64_t infinite_atomic_fetch_add(infinite_atomic_int64 *target, int64_t delta) {
    return atomic_fetch_add_explicit(&target->value, delta, memory_order_acq_rel);
}

int64_t infinite_atomic_fetch_sub(infinite_atomic_int64 *target, int64_t delta) {
    return atomic_fetch_sub_explicit(&target->value, delta, memory_order_acq_rel);
}
