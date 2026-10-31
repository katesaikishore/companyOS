import { describe, expect, it } from 'vitest';
import type { LayaBundleView } from '@companyos/twin-core';
import { formatDecimalBytes } from '../src/renderer/format';
import { layaFraction, layaState, layaStateLabel } from '../src/renderer/labels';
import { LAYA_BUNDLE, LAYA_MIN_FREE_BYTES, totalBytes } from '../src/main/laya';

const view = (patch: Partial<LayaBundleView> = {}): LayaBundleView => ({
  status: 'not_installed',
  receivedBytes: 0,
  totalBytes: totalBytes(LAYA_BUNDLE),
  requiredFreeBytes: LAYA_MIN_FREE_BYTES,
  repo: LAYA_BUNDLE.repo,
  revision: LAYA_BUNDLE.revision,
  hasPartial: false,
  supported: true,
  ...patch,
});

describe('decimal sizes', () => {
  it('says "1.7 GB" for the real bundle and "2.0 GB" for the free space it asks for', () => {
    expect(formatDecimalBytes(totalBytes(LAYA_BUNDLE))).toBe('1.7 GB');
    expect(formatDecimalBytes(LAYA_MIN_FREE_BYTES)).toBe('2.0 GB');
  });

  it('steps down through MB, KB and bytes, and refuses nonsense', () => {
    expect(formatDecimalBytes(3_180_663)).toBe('3 MB');
    expect(formatDecimalBytes(59_000)).toBe('59 KB');
    expect(formatDecimalBytes(355)).toBe('355 B');
    expect(formatDecimalBytes(-1)).toBe('—');
    expect(formatDecimalBytes(Number.NaN)).toBe('—');
  });
});

describe('the decision-model labels', () => {
  it('maps each status to the five states the page shows, with checking counted as downloading', () => {
    expect(layaState(view())).toBe('not_installed');
    expect(layaState(view({ status: 'downloading' }))).toBe('downloading');
    expect(layaState(view({ status: 'verifying' }))).toBe('downloading');
    expect(layaState(view({ status: 'installed' }))).toBe('installed');
    expect(layaState(view({ status: 'failed' }))).toBe('failed');
    expect(layaState(view({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('shows an unsupported system as unavailable, but still shows an installed bundle', () => {
    expect(layaState(view({ supported: false }))).toBe('unsupported');
    expect(layaStateLabel(view({ supported: false }))).toBe('Not available');
    expect(layaState(view({ supported: false, status: 'installed' }))).toBe('installed');
  });

  it('labels progress, a kept partial file and each end state in plain words', () => {
    expect(layaStateLabel(view({ status: 'downloading', receivedBytes: 850_000_000 }))).toBe('Downloading · 850 MB of 1.7 GB');
    expect(layaStateLabel(view({ status: 'verifying', file: 'laya.onnx.data' }))).toBe('Checking laya.onnx.data');
    expect(layaStateLabel(view({ status: 'installed' }))).toBe('Installed');
    expect(layaStateLabel(view({ status: 'failed', message: 'x' }))).toBe('Failed');
    expect(layaStateLabel(view({ status: 'cancelled', hasPartial: true, receivedBytes: 1_000_000 }))).toBe('Cancelled · 1 MB kept');
    expect(layaStateLabel(view({ hasPartial: true, receivedBytes: 500_000_000 }))).toBe('Partly downloaded · 500 MB of 1.7 GB');
    expect(layaStateLabel(view())).toBe('Not installed');
  });

  it('keeps the progress fraction between zero and one, and full once installed', () => {
    expect(layaFraction(view())).toBe(0);
    expect(layaFraction(view({ status: 'downloading', receivedBytes: totalBytes(LAYA_BUNDLE) / 2 }))).toBeCloseTo(0.5);
    expect(layaFraction(view({ status: 'downloading', receivedBytes: 10 * totalBytes(LAYA_BUNDLE) }))).toBe(1);
    expect(layaFraction(view({ status: 'installed' }))).toBe(1);
    expect(layaFraction(view({ totalBytes: 0 }))).toBe(0);
  });
});
