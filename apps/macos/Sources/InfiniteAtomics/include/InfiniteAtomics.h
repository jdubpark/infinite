#ifndef INFINITE_ATOMICS_H
#define INFINITE_ATOMICS_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    _Atomic int64_t value;
} infinite_atomic_int64;

void infinite_atomic_init(infinite_atomic_int64 *target, int64_t initial);
int64_t infinite_atomic_load(const infinite_atomic_int64 *target);
void infinite_atomic_store(infinite_atomic_int64 *target, int64_t value);
int64_t infinite_atomic_fetch_add(infinite_atomic_int64 *target, int64_t delta);
int64_t infinite_atomic_fetch_sub(infinite_atomic_int64 *target, int64_t delta);

#endif
