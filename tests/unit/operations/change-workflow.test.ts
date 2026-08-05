import { describe, expect, it, vi } from 'vitest';

import { ChangeWorkflow } from '../../../src/operations/change-workflow.js';

function fixture(options: { empty?: boolean; verify?: boolean; refreshError?: Error } = {}) {
  const state = { ranges: [{ range: 'Plan!A2', values: options.empty ? [] : [['old']] }] };
  const preflight = {
    affectedResources: [
      { kind: 'spreadsheet' as const, id: 'book', label: 'book' },
      { kind: 'range' as const, id: 'book:Plan!A2', label: 'Plan!A2' },
    ],
    preview: { kind: 'values' as const, before: state.ranges[0]?.values, after: [['new']] },
    riskInspection: { targetCellsVerifiedEmpty: options.empty === true },
    driveRevisions: { book: '7' },
    state,
  };
  const gateway = {
    inspect: vi.fn().mockImplementation(async (operation: string) =>
      operation === 'sign_out'
        ? {
            ...preflight,
            affectedResources: [{ kind: 'account' as const, id: 'google', label: 'Google' }],
            preview: {
              kind: 'exact' as const,
              before: { connected: true },
              after: { connected: false },
            },
            driveRevisions: {},
          }
        : preflight
    ),
    getRevisions: vi.fn().mockResolvedValue({ book: '7' }),
    captureState: vi.fn().mockResolvedValue(state),
    verify: vi.fn().mockResolvedValue(options.verify ?? true),
  };
  const auditStore = {
    recordWriteAudit: vi.fn(),
    recordPendingVerification: vi.fn(),
    hasPendingVerification: vi.fn().mockReturnValue(false),
    clearPendingVerifications: vi.fn(),
  };
  const refresh = options.refreshError
    ? vi.fn().mockRejectedValue(options.refreshError)
    : vi.fn().mockResolvedValue(undefined);
  return { gateway, auditStore, refresh };
}

describe('ChangeWorkflow', () => {
  const input = {
    operation: 'update_values',
    arguments: { spreadsheetId: 'book', range: 'Plan!A2', values: [['new']] },
    execute: vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' }),
  };

  it('pre-reads populated cells and prepares the complete operation without applying it', async () => {
    const dependencies = fixture();
    const execute = vi.fn();
    const workflow = new ChangeWorkflow(dependencies);

    const outcome = await workflow.execute({ ...input, execute });

    expect(outcome.kind).toBe('proposal');
    expect(outcome.proposal).toMatchObject({
      operation: 'update_values',
      arguments: input.arguments,
      preview: { kind: 'values', before: [['old']], after: [['new']] },
      riskReasons: ['Populated cells would be overwritten'],
      editable: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies verified-empty writes directly then verifies, audits, and refreshes', async () => {
    const dependencies = fixture({ empty: true });
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' });
    const workflow = new ChangeWorkflow(dependencies);

    const outcome = await workflow.execute({ ...input, execute });

    expect(outcome).toMatchObject({
      kind: 'direct',
      data: { updatedRange: 'Plan!A2' },
      verificationState: 'verified',
    });
    expect(dependencies.gateway.verify).toHaveBeenCalledOnce();
    expect(dependencies.refresh).toHaveBeenCalledOnce();
    expect(dependencies.auditStore.recordWriteAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'update_values',
        approval: 'direct',
        verificationState: 'verified',
      })
    );
  });

  it('records applied-verification-pending and blocks dependent destructive operations', async () => {
    const dependencies = fixture({ empty: true, verify: false });
    const workflow = new ChangeWorkflow(dependencies);
    const outcome = await workflow.execute(input);

    expect(outcome).toMatchObject({
      kind: 'direct',
      verificationState: 'applied_verification_pending',
    });
    expect(dependencies.auditStore.recordPendingVerification).toHaveBeenCalledOnce();
    dependencies.auditStore.hasPendingVerification.mockReturnValue(true);

    await expect(
      workflow.execute({
        operation: 'delete_rows',
        arguments: { spreadsheetId: 'book', range: 'Plan!2:2' },
        execute: vi.fn(),
      })
    ).rejects.toThrow('pending verification');
    await expect(
      workflow.execute({
        operation: 'sign_out',
        arguments: {},
        execute: vi.fn(),
        refresh: false,
      })
    ).rejects.toThrow('pending verification');
    expect(dependencies.auditStore.hasPendingVerification).toHaveBeenLastCalledWith([]);
  });

  it('rechecks revisions and target state before approved application', async () => {
    const dependencies = fixture();
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' });
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({ ...input, execute });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');
    const nonce = workflow.confirmationToken(prepared.proposal.id);
    dependencies.gateway.captureState.mockResolvedValue({
      ranges: [{ range: 'Plan!A2', values: [['changed']] }],
    });

    await expect(workflow.approve(prepared.proposal.id, nonce)).rejects.toThrow(
      'target state changed'
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes one concurrent approval at most once', async () => {
    const dependencies = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await barrier;
      return { updatedRange: 'Plan!A2' };
    });
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({ ...input, execute });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');
    const nonce = workflow.confirmationToken(prepared.proposal.id);

    const first = workflow.approve(prepared.proposal.id, nonce);
    while (execute.mock.calls.length === 0) await Promise.resolve();
    const second = workflow.approve(prepared.proposal.id, nonce);
    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serializes distinct overlapping proposals by affected resource', async () => {
    const dependencies = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const firstExecute = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await barrier;
      active -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const secondExecute = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const workflow = new ChangeWorkflow(dependencies);
    const first = await workflow.execute({ ...input, execute: firstExecute });
    const second = await workflow.execute({ ...input, execute: secondExecute });
    if (first.kind !== 'proposal' || second.kind !== 'proposal')
      throw new Error('expected proposals');

    const firstApproval = workflow.approve(
      first.proposal.id,
      workflow.confirmationToken(first.proposal.id)
    );
    while (firstExecute.mock.calls.length === 0) await Promise.resolve();
    const secondApproval = workflow.approve(
      second.proposal.id,
      workflow.confirmationToken(second.proposal.id)
    );
    await Promise.resolve();
    expect(secondExecute).not.toHaveBeenCalled();
    release();
    await Promise.all([firstApproval, secondApproval]);
    expect(maximumActive).toBe(1);
  });

  it('rotates confirmation and permits retry after a pre-apply failure', async () => {
    const dependencies = fixture();
    dependencies.gateway.getRevisions
      .mockRejectedValueOnce(new Error('revision read unavailable'))
      .mockResolvedValue({ book: '7' });
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' });
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({ ...input, execute });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');
    const firstNonce = workflow.confirmationToken(prepared.proposal.id);

    await expect(workflow.approve(prepared.proposal.id, firstNonce)).rejects.toThrow(
      'revision read'
    );
    expect(execute).not.toHaveBeenCalled();
    const retryNonce = workflow.confirmationToken(prepared.proposal.id);
    expect(retryNonce).not.toBe(firstNonce);
    await expect(workflow.approve(prepared.proposal.id, firstNonce)).rejects.toThrow(
      'confirmation token'
    );
    await expect(workflow.approve(prepared.proposal.id, retryNonce)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not re-execute when bookkeeping fails after application', async () => {
    const dependencies = fixture({ empty: true });
    dependencies.auditStore.clearPendingVerifications.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    dependencies.auditStore.recordPendingVerification.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    dependencies.auditStore.recordWriteAudit.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' });
    const workflow = new ChangeWorkflow(dependencies);
    const outcome = await workflow.execute({ ...input, execute });

    expect(outcome).toMatchObject({
      kind: 'direct',
      verificationState: 'applied_verification_pending',
    });
    await expect(
      workflow.execute({
        operation: 'delete_rows',
        arguments: input.arguments,
        execute: vi.fn(),
      })
    ).rejects.toThrow('pending verification');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('invalidates an approved executor immediately after execute succeeds', async () => {
    const dependencies = fixture();
    dependencies.auditStore.recordWriteAudit.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A2' });
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({ ...input, execute });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');
    const nonce = workflow.confirmationToken(prepared.proposal.id);

    await expect(workflow.approve(prepared.proposal.id, nonce)).resolves.toMatchObject({
      status: 'applied_verification_pending',
    });
    await expect(workflow.approve(prepared.proposal.id, nonce)).rejects.toThrow(/applied/u);
    expect(execute).toHaveBeenCalledOnce();
  });
});
