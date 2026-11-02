import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  },
}));

vi.mock('electron', () => electron);

import { CloudConnectorError } from '../../src/main/connectors-cloud/oauth';
import { requireSealedStorage } from '../../src/main/connectors-cloud/seal';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realSwitch = process.env.COMPANYOS_TEST_BASIC_STORE;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  electron.app.isPackaged = false;
  electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
  electron.safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  delete process.env.COMPANYOS_TEST_BASIC_STORE;
  setPlatform('linux');
});

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  if (realSwitch === undefined) delete process.env.COMPANYOS_TEST_BASIC_STORE;
  else process.env.COMPANYOS_TEST_BASIC_STORE = realSwitch;
});

describe('requireSealedStorage', () => {
  it('refuses when the system has no secure storage', () => {
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    expect(() => requireSealedStorage()).toThrow(CloudConnectorError);
  });

  it('refuses the plain-text keychain backend on Linux', () => {
    electron.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(() => requireSealedStorage()).toThrow(CloudConnectorError);
  });

  it('allows the plain-text backend only for an unpackaged run that sets the test switch', () => {
    electron.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    process.env.COMPANYOS_TEST_BASIC_STORE = '1';
    expect(() => requireSealedStorage()).not.toThrow();
  });

  it('never honours the test switch in a packaged app', () => {
    electron.app.isPackaged = true;
    electron.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    process.env.COMPANYOS_TEST_BASIC_STORE = '1';
    expect(() => requireSealedStorage()).toThrow(CloudConnectorError);
  });

  it('does not apply the plain-text refusal off Linux', () => {
    setPlatform('darwin');
    electron.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(() => requireSealedStorage()).not.toThrow();
  });
});
