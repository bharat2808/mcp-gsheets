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

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await Promise.resolve();
  }
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

  it('serializes direct inspection through application so a second empty-range write sees the first', async () => {
    let currentValue: string | null = null;
    const observedBefore: Array<string | null> = [];
    let activeApplications = 0;
    let maximumActiveApplications = 0;
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dependencies = fixture({ empty: true });
    dependencies.gateway.inspect.mockImplementation(async (_operation, arguments_) => {
      observedBefore.push(currentValue);
      return {
        affectedResources: [
          { kind: 'spreadsheet' as const, id: 'book', label: 'book' },
          { kind: 'range' as const, id: 'book:Plan!A2', label: 'Plan!A2' },
        ],
        preview: {
          kind: 'values' as const,
          before: currentValue === null ? [] : [[currentValue]],
          after: arguments_.values,
        },
        riskInspection: { targetCellsVerifiedEmpty: currentValue === null },
        driveRevisions: { book: '7' },
        state: { value: currentValue },
      };
    });
    const firstExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      await firstBarrier;
      currentValue = 'first';
      activeApplications -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const secondExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      currentValue = 'second';
      activeApplications -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const workflow = new ChangeWorkflow(dependencies);

    const first = workflow.execute({
      ...input,
      arguments: { ...input.arguments, values: [['first']] },
      execute: firstExecute,
    });
    await waitUntil(() => firstExecute.mock.calls.length === 1);
    const second = workflow.execute({
      ...input,
      arguments: { ...input.arguments, values: [['second']] },
      execute: secondExecute,
    });
    await Promise.resolve();
    releaseFirst();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.kind).toBe('direct');
    expect(secondOutcome.kind).toBe('proposal');
    expect(observedBefore).toEqual([null, 'first']);
    expect(maximumActiveApplications).toBe(1);
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it('keeps a direct mutation out of an overlapping approved application', async () => {
    const events: string[] = [];
    let activeApplications = 0;
    let maximumActiveApplications = 0;
    let releaseApproved!: () => void;
    const approvedBarrier = new Promise<void>((resolve) => {
      releaseApproved = resolve;
    });
    const dependencies = fixture();
    dependencies.gateway.inspect.mockImplementation(async (_operation, arguments_) => {
      const direct = arguments_.range === 'Plan!B2';
      if (direct) {
        events.push('direct-preflight');
      }
      return {
        affectedResources: [
          { kind: 'spreadsheet' as const, id: 'book', label: 'book' },
          {
            kind: 'range' as const,
            id: `book:${String(arguments_.range)}`,
            label: String(arguments_.range),
          },
        ],
        preview: {
          kind: 'values' as const,
          before: direct ? [] : [['old']],
          after: arguments_.values,
        },
        riskInspection: { targetCellsVerifiedEmpty: direct },
        driveRevisions: { book: '7' },
        state: { range: arguments_.range, before: direct ? null : 'old' },
      };
    });
    dependencies.gateway.captureState.mockImplementation(async (proposal) =>
      structuredClone(proposal.preflightState)
    );
    const approvedExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      await approvedBarrier;
      events.push('approved-applied');
      activeApplications -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const directExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      events.push('direct-applied');
      activeApplications -= 1;
      return { updatedRange: 'Plan!B2' };
    });
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({ ...input, execute: approvedExecute });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');

    const approved = workflow.approve(
      prepared.proposal.id,
      workflow.confirmationToken(prepared.proposal.id)
    );
    await waitUntil(() => approvedExecute.mock.calls.length === 1);
    const direct = workflow.execute({
      ...input,
      arguments: { ...input.arguments, range: 'Plan!B2' },
      execute: directExecute,
    });
    await Promise.resolve();
    releaseApproved();
    await Promise.all([approved, direct]);

    expect(maximumActiveApplications).toBe(1);
    expect(events).toEqual(['approved-applied', 'direct-preflight', 'direct-applied']);
  });

  it('keeps direct spreadsheet mutation out of an approved sign-out application', async () => {
    const events: string[] = [];
    let activeApplications = 0;
    let maximumActiveApplications = 0;
    let releaseSignOut!: () => void;
    const signOutBarrier = new Promise<void>((resolve) => {
      releaseSignOut = resolve;
    });
    const dependencies = fixture({ empty: true });
    dependencies.gateway.captureState.mockImplementation(async (proposal) =>
      structuredClone(proposal.preflightState)
    );
    const signOutExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      await signOutBarrier;
      events.push('sign-out-applied');
      activeApplications -= 1;
      return { signedOut: true };
    });
    const directExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      events.push('direct-applied');
      activeApplications -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    dependencies.gateway.inspect.mockImplementation(async (operation) => {
      if (operation !== 'sign_out') {
        events.push('direct-preflight');
      }
      return operation === 'sign_out'
        ? {
            affectedResources: [
              { kind: 'account' as const, id: 'google', label: 'Connected Google account' },
            ],
            preview: {
              kind: 'exact' as const,
              before: { connected: true },
              after: { connected: false },
            },
            riskInspection: {},
            driveRevisions: {},
            state: { connected: true },
          }
        : {
            affectedResources: [
              { kind: 'spreadsheet' as const, id: 'book', label: 'book' },
              { kind: 'range' as const, id: 'book:Plan!A2', label: 'Plan!A2' },
            ],
            preview: { kind: 'values' as const, before: [], after: [['new']] },
            riskInspection: { targetCellsVerifiedEmpty: true },
            driveRevisions: { book: '7' },
            state: { value: null },
          };
    });
    dependencies.gateway.getRevisions.mockImplementation(async (proposal) =>
      proposal.operation === 'sign_out' ? {} : { book: '7' }
    );
    const workflow = new ChangeWorkflow(dependencies);
    const prepared = await workflow.execute({
      operation: 'sign_out',
      arguments: {},
      execute: signOutExecute,
      refresh: false,
      persistOutcome: false,
    });
    if (prepared.kind !== 'proposal') throw new Error('expected proposal');

    const signOut = workflow.approve(
      prepared.proposal.id,
      workflow.confirmationToken(prepared.proposal.id)
    );
    await waitUntil(() => signOutExecute.mock.calls.length === 1);
    const direct = workflow.execute({ ...input, execute: directExecute });
    await Promise.resolve();
    releaseSignOut();
    await Promise.all([signOut, direct]);

    expect(maximumActiveApplications).toBe(1);
    expect(events).toEqual(['sign-out-applied', 'direct-preflight', 'direct-applied']);
  });

  it('keeps an approved spreadsheet mutation out of an approved sign-out application', async () => {
    let activeApplications = 0;
    let maximumActiveApplications = 0;
    let releaseSignOut!: () => void;
    const signOutBarrier = new Promise<void>((resolve) => {
      releaseSignOut = resolve;
    });
    const dependencies = fixture();
    dependencies.gateway.captureState.mockImplementation(async (proposal) =>
      structuredClone(proposal.preflightState)
    );
    dependencies.gateway.getRevisions.mockImplementation(async (proposal) =>
      proposal.operation === 'sign_out' ? {} : { book: '7' }
    );
    const signOutExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      await signOutBarrier;
      activeApplications -= 1;
      return { signedOut: true };
    });
    const spreadsheetExecute = vi.fn(async () => {
      activeApplications += 1;
      maximumActiveApplications = Math.max(maximumActiveApplications, activeApplications);
      activeApplications -= 1;
      return { updatedRange: 'Plan!A2' };
    });
    const workflow = new ChangeWorkflow(dependencies);
    const signOutProposal = await workflow.execute({
      operation: 'sign_out',
      arguments: {},
      execute: signOutExecute,
      refresh: false,
      persistOutcome: false,
    });
    const spreadsheetProposal = await workflow.execute({ ...input, execute: spreadsheetExecute });
    if (signOutProposal.kind !== 'proposal' || spreadsheetProposal.kind !== 'proposal') {
      throw new Error('expected proposals');
    }

    const signOut = workflow.approve(
      signOutProposal.proposal.id,
      workflow.confirmationToken(signOutProposal.proposal.id)
    );
    await waitUntil(() => signOutExecute.mock.calls.length === 1);
    const spreadsheet = workflow.approve(
      spreadsheetProposal.proposal.id,
      workflow.confirmationToken(spreadsheetProposal.proposal.id)
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSignOut();
    await Promise.all([signOut, spreadsheet]);

    expect(maximumActiveApplications).toBe(1);
  });
});
