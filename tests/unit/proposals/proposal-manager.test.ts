import { describe, expect, it, vi } from 'vitest';

import { ProposalManager } from '../../../src/proposals/proposal-manager.js';

describe('ProposalManager', () => {
  const baseRequest = {
    spreadsheetId: 'spreadsheet-1',
    spreadsheetName: 'Accounts',
    spreadsheetPath: '/Finance/Accounts',
    sheetId: 7,
    sheetTitle: 'Accounts',
    operation: 'update' as const,
    rowNumber: 4,
    values: { Status: 'Paid' },
    expectedValues: { Status: 'Open' },
    baseRevision: '12',
  };

  it('requires an app approval before executing a proposal', async () => {
    const gateway = {
      getRevision: vi.fn().mockResolvedValue('12'),
      readRow: vi.fn().mockResolvedValue({ Status: 'Open' }),
      apply: vi.fn().mockResolvedValue({ updatedRange: 'Accounts!A4:D4' }),
    };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);

    await expect(manager.approve(proposal.id)).rejects.toThrow('visual confirmation');
    manager.recordVisualConfirmation(proposal.id, manager.confirmationToken(proposal.id));
    await expect(manager.approve(proposal.id)).resolves.toMatchObject({ status: 'applied' });
    expect(gateway.apply).toHaveBeenCalledOnce();
  });

  it('refuses stale revisions and changed target rows', async () => {
    const gateway = {
      getRevision: vi.fn().mockResolvedValue('13'),
      readRow: vi.fn().mockResolvedValue({ Status: 'Open' }),
      apply: vi.fn(),
    };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);
    manager.recordVisualConfirmation(proposal.id, manager.confirmationToken(proposal.id));

    await expect(manager.approve(proposal.id)).rejects.toThrow('revision changed');
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it('expires proposals after fifteen minutes', () => {
    let now = Date.parse('2026-08-05T00:00:00.000Z');
    const gateway = { getRevision: vi.fn(), readRow: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway, () => now);
    const proposal = manager.prepare(baseRequest);
    now += 15 * 60 * 1000 + 1;

    expect(() => manager.review(proposal.id)).toThrow('expired');
  });

  it('rejects formula values', () => {
    const gateway = { getRevision: vi.fn(), readRow: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);

    expect(() => manager.prepare({ ...baseRequest, values: { Status: '=NOW()' } })).toThrow(
      'Formula values are not supported'
    );
  });

  it('rejects an approval nonce that was not delivered to the app', () => {
    const gateway = { getRevision: vi.fn(), readRow: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);

    expect(() => manager.recordVisualConfirmation(proposal.id, 'model-visible-id')).toThrow(
      'confirmation token'
    );
  });
});
