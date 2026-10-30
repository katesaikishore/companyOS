import { randomBytes } from 'node:crypto';

/**
 * A number strictly between 0 and 1 from the operating system's random source. It has 53 random bits, so every value
 * is exactly representable and none is ever 0 or 1.
 */
export function systemUniform(): number {
  const high = randomBytes(4).readUInt32BE(0);
  const low = randomBytes(4).readUInt32BE(0) >>> 11;
  return (high * 2 ** 21 + low + 0.5) / 2 ** 53;
}

/**
 * A sample from Laplace(0, scale), by inverting the distribution function. `uniform` supplies values strictly between
 * 0 and 1; tests pass a seeded source so the output is repeatable.
 *
 * This is a reference implementation for the release math. Floating-point Laplace samplers have known weaknesses, so
 * production releases should use a vetted library (plan 8.2 names OpenDP).
 */
export function laplace(scale: number, uniform: () => number): number {
  const centred = uniform() - 0.5;
  return -scale * Math.sign(centred) * Math.log(1 - 2 * Math.abs(centred));
}
