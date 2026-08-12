import { describe, expect, it, vi } from 'vitest';

import { ProposalManager } from '../../../src/proposals/proposal-manager.js';

describe('ProposalManager', () => {
  const baseRequest = {
    operation: 'update_values',
    arguments: { spreadsheetId: 'spreadsheet-1', range: 'Accounts!D4', values: [['Paid']] },
    affectedResources: [
      { kind: 'spreadsheet' as const, id: 'spreadsheet-1', label: 'Accounts' },
      { kind: 'range' as const, id: 'spreadsheet-1:Accounts!D4', label: 'Accounts!D4' },
    ],
    preview: { kind: 'values' as const, before: [['Open']], after: [['Paid']] },
    riskReasons: ['Populated cells would be overwritten'],
    driveRevisions: { 'spreadsheet-1': '12' },
    editable: true,
    preflightState: { ranges: [{ range: 'Accounts!D4', values: [['Open']] }] },
  };

  it('requires an app approval before executing a proposal', async () => {
    const gateway = {
      getRevisions: vi.fn().mockResolvedValue({ 'spreadsheet-1': '12' }),
      captureState: vi.fn().mockResolvedValue(baseRequest.preflightState),
      apply: vi.fn().mockResolvedValue({
        data: { updatedRange: 'Accounts!D4' },
        verificationState: 'verified' as const,
      }),
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
      getRevisions: vi.fn().mockResolvedValue({ 'spreadsheet-1': '13' }),
      captureState: vi.fn().mockResolvedValue(baseRequest.preflightState),
      apply: vi.fn(),
    };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);
    manager.recordVisualConfirmation(proposal.id, manager.confirmationToken(proposal.id));

    await expect(manager.approve(proposal.id)).rejects.toThrow('revision changed');
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it('expires proposals after exactly four minutes and retains the terminal state', () => {
    let now = Date.parse('2026-08-05T00:00:00.000Z');
    const gateway = { getRevisions: vi.fn(), captureState: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway, () => now);
    const proposal = manager.prepare(baseRequest);

    expect(proposal.expiresAt).toBe('2026-08-05T00:04:00.000Z');
    now += 4 * 60 * 1000;
    expect(manager.review(proposal.id)).toMatchObject({ status: 'expired', nonce: '' });
    expect(manager.review(proposal.id)).toMatchObject({ status: 'expired', nonce: '' });
  });

  it('rejects every repeated action after expiry or consumption', async () => {
    let now = Date.parse('2026-08-05T00:00:00.000Z');
    const gateway = {
      getRevisions: vi.fn().mockResolvedValue(baseRequest.driveRevisions),
      captureState: vi.fn().mockResolvedValue(baseRequest.preflightState),
      apply: vi.fn().mockResolvedValue({
        data: { updatedRange: 'Accounts!D4' },
        verificationState: 'verified' as const,
      }),
    };
    const manager = new ProposalManager(gateway, () => now);
    const expired = manager.prepare(baseRequest);
    const expiredToken = manager.confirmationToken(expired.id);
    now += 4 * 60 * 1000;

    expect(() => manager.edit(expired.id, [['Settled']])).toThrow('Proposal is expired');
    expect(() => manager.recordVisualConfirmation(expired.id, expiredToken)).toThrow(
      'Proposal is expired'
    );
    await expect(manager.approve(expired.id)).rejects.toThrow('Proposal is expired');
    expect(() => manager.cancel(expired.id)).toThrow('Proposal is expired');

    const applied = manager.prepare(baseRequest);
    manager.recordVisualConfirmation(applied.id, manager.confirmationToken(applied.id));
    await manager.approve(applied.id);
    await expect(manager.approve(applied.id)).rejects.toThrow('Proposal is applied');
    expect(() => manager.edit(applied.id, [['Again']])).toThrow('Proposal is applied');
    expect(() => manager.cancel(applied.id)).toThrow('Proposal is applied');
    expect(gateway.apply).toHaveBeenCalledOnce();

    const cancelled = manager.prepare(baseRequest);
    manager.cancel(cancelled.id);
    expect(() => manager.cancel(cancelled.id)).toThrow('Proposal is cancelled');
    expect(() => manager.edit(cancelled.id, [['Again']])).toThrow('Proposal is cancelled');
  });

  it('bounds retained proposals and prunes the oldest entries', () => {
    const gateway = { getRevisions: vi.fn(), captureState: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);
    const proposals = Array.from({ length: 300 }, () => manager.prepare(baseRequest));

    expect(() => manager.review(proposals[0]!.id)).toThrow('Unknown proposal');
    expect(manager.review(proposals.at(-1)!.id).id).toBe(proposals.at(-1)!.id);
  });

  it('creates a versioned generalized proposal with a nonce and verification state', () => {
    const gateway = { getRevisions: vi.fn(), captureState: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);

    expect(proposal).toMatchObject({
      version: 2,
      operation: 'update_values',
      arguments: baseRequest.arguments,
      affectedResources: baseRequest.affectedResources,
      preview: baseRequest.preview,
      riskReasons: baseRequest.riskReasons,
      driveRevisions: { 'spreadsheet-1': '12' },
      status: 'pending',
      verificationState: 'not_started',
    });
    expect(proposal.nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
  });

  it('rejects an approval nonce that was not delivered to the app', () => {
    const gateway = { getRevisions: vi.fn(), captureState: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);

    expect(() => manager.recordVisualConfirmation(proposal.id, 'model-visible-id')).toThrow(
      'confirmation token'
    );
  });

  it('edits only value previews and rotates the app nonce', () => {
    const gateway = { getRevisions: vi.fn(), captureState: vi.fn(), apply: vi.fn() };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);
    const firstNonce = manager.confirmationToken(proposal.id);

    const edited = manager.edit(proposal.id, [['Settled']]);

    expect(edited.preview.after).toEqual([['Settled']]);
    expect(edited.arguments.values).toEqual([['Settled']]);
    expect(manager.confirmationToken(proposal.id)).not.toBe(firstNonce);
    const structural = manager.prepare({
      ...baseRequest,
      operation: 'delete_rows',
      arguments: { spreadsheetId: 'spreadsheet-1', range: 'Accounts!4:4' },
      preview: { kind: 'exact', before: { rows: [4] }, after: { rows: [] } },
      editable: false,
    });
    expect(() => manager.edit(structural.id, [['anything']])).toThrow('not editable');
  });

  it('uses a distinct applied-verification-pending lifecycle state', async () => {
    const gateway = {
      getRevisions: vi.fn().mockResolvedValue(baseRequest.driveRevisions),
      captureState: vi.fn().mockResolvedValue(baseRequest.preflightState),
      apply: vi.fn().mockResolvedValue({
        data: { updatedRange: 'Accounts!D4' },
        verificationState: 'applied_verification_pending' as const,
        verificationError: 'Index refresh failed',
      }),
    };
    const manager = new ProposalManager(gateway);
    const proposal = manager.prepare(baseRequest);
    manager.recordVisualConfirmation(proposal.id, manager.confirmationToken(proposal.id));

    await expect(manager.approve(proposal.id)).resolves.toMatchObject({
      status: 'applied_verification_pending',
      verificationState: 'applied_verification_pending',
      result: { verificationError: 'Index refresh failed' },
    });
  });
});
