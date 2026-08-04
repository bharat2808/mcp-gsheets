import { describe, expect, it } from 'vitest';

import { KeyringBackend, KeyringEntry } from '../../../src/auth/keyring-backend.js';

describe('KeyringBackend', () => {
  it('maps credential operations to the platform keyring entry', async () => {
    const values = new Map<string, string>();
    const factory = (service: string, account: string): KeyringEntry => ({
      getPassword: () => values.get(`${service}:${account}`) ?? null,
      setPassword: (password) => {
        values.set(`${service}:${account}`, password);
      },
      deletePassword: () => values.delete(`${service}:${account}`),
    });
    const backend = new KeyringBackend(factory);

    expect(await backend.getPassword('gsheets', 'token')).toBeNull();
    await backend.setPassword('gsheets', 'token', 'secret');
    expect(await backend.getPassword('gsheets', 'token')).toBe('secret');
    expect(await backend.deletePassword('gsheets', 'token')).toBe(true);
  });
});
