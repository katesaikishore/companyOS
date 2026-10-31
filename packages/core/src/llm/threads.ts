/**
 * How many CPU threads the model may use: half of the machine's cores that are useful for math, and at least one.
 *
 * llama.cpp's threads wait for each other at every step, so when another program holds one core, a run that uses all of
 * them stalls. On the 4-core test machine, one busy process made a 133-token name take 3 to 20 s with 4 threads, against
 * about 1 s with 2. With two other busy processes it passed the 20 s naming limit (docs/research/real-model-checks.md).
 * Naming runs in the background and the prompt is short, so fewer threads cost little. This is measured on one machine
 * and one small model. A large model on CPU alone may need more threads to answer in time.
 */
export function modelThreads(cpuMathCores: number): number {
  if (!Number.isFinite(cpuMathCores) || cpuMathCores < 2) return 1;
  return Math.floor(cpuMathCores / 2);
}
