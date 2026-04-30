/*
 * WHAT: Provide a tiny deterministic random-number generator for the map pipeline.
 * HOW: Hash the incoming seed once, then step a mulberry-style integer generator for each sample.
 * WHY: The generator needs reproducible pseudo-random values without pulling in another dependency.
 */

const UINT32_RANGE = 2 ** 32;

/**
 * WHAT: Build a seeded random API with helpers for raw values, ranges, and item picking.
 * HOW: Reuse the internal integer state for every call so each consumer advances the same deterministic stream.
 * WHY: Generation steps need one shared source of entropy to keep maps replayable from the same input seed.
 */
export function createSeededRandom(seed) {
  let state = xmur3(seed)();
  return {
    next() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    },
    between(min, max) {
      return min + (max - min) * this.next();
    },
    pick(items) {
      return items[Math.floor(this.next() * items.length)];
    },
  };
}

/**
 * WHAT: Turn an arbitrary string seed into a repeatable 32-bit starting state.
 * HOW: Mix each character into the hash using the standard xmur3 scramble constants.
 * WHY: A stable seed hash lets short human-readable seeds drive the same random stream every time.
 */
function xmur3(input) {
  let hash = 1779033703 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return function seedHash() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}
