import { describe, expect, it, vi } from 'vitest';

import { GoogleSheetsGateway } from '../../../src/google/google-api-client.js';
import {
  getAuthenticatedClient,
  runWithGoogleSheetsGateway,
} from '../../../src/utils/google-auth.js';

describe('Desktop OAuth gateway context', () => {
  it('rejects retained handler access outside a connected runtime operation', async () => {
    await expect(getAuthenticatedClient()).rejects.toThrow(
      'connected Desktop OAuth gateway'
    );
  });

  it('provides the operation-scoped gateway client', async () => {
    const sheetsClient = { spreadsheets: { values: {} } };
    const gateway = new GoogleSheetsGateway(
      {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiryDate: 1_900_000_000_000,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        tokenType: 'Bearer',
      },
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      { sheetsClient }
    );

    const client = await runWithGoogleSheetsGateway(
      gateway,
      { idempotent: true },
      getAuthenticatedClient
    );

    expect(client.spreadsheets.values).toEqual({});
  });
});
