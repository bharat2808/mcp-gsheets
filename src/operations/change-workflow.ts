import { WriteAudit } from '../domain/types.js';
import {
  AffectedResource,
  ChangeApplicationResult,
  ChangePreview,
  ChangeProposal,
  ProposalPresentationData,
  ProposalManager,
} from '../proposals/proposal-manager.js';
import {
  classifyOperationRisk,
  isDestructiveOperation,
  RiskInspection,
} from '../risk/risk-classifier.js';

export interface OperationPreflight {
  affectedResources: AffectedResource[];
  preview: ChangePreview;
  riskInspection: RiskInspection;
  driveRevisions: Record<string, string>;
  presentation?: ProposalPresentationData;
  state: unknown;
}

export interface ChangeWorkflowGateway {
  inspect(operation: string, arguments_: Record<string, unknown>): Promise<OperationPreflight>;
  getRevisions(proposal: ChangeProposal): Promise<Record<string, string>>;
  captureState(proposal: ChangeProposal): Promise<unknown>;
  verify(
    operation: string,
    arguments_: Record<string, unknown>,
    result: unknown,
    preflight: OperationPreflight
  ): Promise<boolean>;
}

export interface ChangeAuditStore {
  recordWriteAudit(audit: WriteAudit): void;
  recordPendingVerification(pending: {
    operation: string;
    recordedAt: string;
    affectedResourceIds: string[];
    error: string;
  }): void;
  hasPendingVerification(resourceIds: readonly string[]): boolean;
  clearPendingVerifications(resourceIds?: readonly string[]): void;
  recordWriteOutcome?(outcome: {
    audit: WriteAudit;
    pending?: {
      operation: string;
      recordedAt: string;
      affectedResourceIds: string[];
      error: string;
    };
    clearResourceIds?: string[];
  }): void;
}

export interface ChangeWorkflowDependencies {
  gateway: ChangeWorkflowGateway;
  auditStore: ChangeAuditStore;
  refresh: (affectedResources: readonly AffectedResource[]) => Promise<unknown>;
  now?: () => number;
}

export interface ChangeRefreshResult {
  refreshedResourceIds: string[];
  removedResourceIds: string[];
  failedResourceIds: string[];
  errors?: Record<string, string>;
}

export interface ExecuteChangeInput {
  operation: string;
  arguments: Record<string, unknown>;
  execute: (
    arguments_: Record<string, unknown>,
    context: { approval: 'direct' | 'reviewed' }
  ) => Promise<unknown>;
  refresh?: boolean;
  preflight?: OperationPreflight;
  persistOutcome?: boolean;
}

export type ChangeWorkflowOutcome =
  | {
      kind: 'direct';
      data: unknown;
      verificationState: ChangeApplicationResult['verificationState'];
      verificationError?: string;
    }
  | { kind: 'proposal'; proposal: ChangeProposal };

function resourceIds(resources: readonly AffectedResource[]): string[] {
  return resources.map((resource) => `${resource.kind}:${resource.id}`);
}

export class ChangeWorkflow {
  readonly #gateway: ChangeWorkflowGateway;
  readonly #auditStore: ChangeAuditStore;
  readonly #refresh: ChangeWorkflowDependencies['refresh'];
  readonly #now: () => number;
  readonly #executors = new Map<
    string,
    {
      execute: ExecuteChangeInput['execute'];
      refresh: boolean;
      persistOutcome: boolean;
      preflight: OperationPreflight;
    }
  >();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #pendingFallback = new Set<string>();
  readonly #proposals: ProposalManager;

  constructor(dependencies: ChangeWorkflowDependencies) {
    this.#gateway = dependencies.gateway;
    this.#auditStore = dependencies.auditStore;
    this.#refresh = dependencies.refresh;
    this.#now = dependencies.now ?? Date.now;
    this.#proposals = new ProposalManager(
      {
        getRevisions: (proposal) => this.#gateway.getRevisions(proposal),
        captureState: (proposal) => this.#gateway.captureState(proposal),
        apply: (proposal, markApplicationOccurred) =>
          this.#applyApproved(proposal, markApplicationOccurred),
      },
      this.#now,
      (proposalIds) => {
        for (const proposalId of proposalIds) {
          this.#executors.delete(proposalId);
        }
      }
    );
  }

  async execute(input: ExecuteChangeInput): Promise<ChangeWorkflowOutcome> {
    return this.#withMutationLock(async () => {
      const preflight =
        input.preflight ?? (await this.#gateway.inspect(input.operation, input.arguments));
      const ids = resourceIds(preflight.affectedResources);
      if (
        isDestructiveOperation(input.operation) &&
        this.#hasPendingVerification(input.operation, ids)
      ) {
        throw new Error(
          'A dependent destructive change is blocked while an earlier application has pending verification'
        );
      }
      const classification = classifyOperationRisk({
        operation: input.operation,
        arguments: input.arguments,
        inspection: preflight.riskInspection,
      });
      if (classification.decision === 'reviewed') {
        const proposal = this.#proposals.prepare({
          operation: input.operation,
          arguments: input.arguments,
          affectedResources: preflight.affectedResources,
          preview: preflight.preview,
          riskReasons: classification.reasons,
          driveRevisions: preflight.driveRevisions,
          editable: preflight.preview.kind === 'values',
          ...(preflight.presentation ? { presentation: preflight.presentation } : {}),
          preflightState: preflight.state,
        });
        this.#executors.set(proposal.id, {
          execute: input.execute,
          refresh: input.refresh !== false,
          persistOutcome: input.persistOutcome !== false,
          preflight,
        });
        return { kind: 'proposal', proposal };
      }

      const application = await this.#applyAndVerify(
        input.operation,
        input.arguments,
        preflight,
        input.execute,
        input.refresh !== false,
        'direct',
        undefined,
        undefined,
        input.persistOutcome !== false
      );
      return { kind: 'direct', ...application };
    });
  }

  review(id: string): ChangeProposal {
    return this.#proposals.review(id);
  }

  confirmationToken(id: string): string {
    return this.#proposals.confirmationToken(id);
  }

  edit(id: string, values: unknown): ChangeProposal {
    return this.#proposals.edit(id, values);
  }

  cancel(id: string): ChangeProposal {
    this.#executors.delete(id);
    return this.#proposals.cancel(id);
  }

  async approve(id: string, nonce: string): Promise<ChangeProposal> {
    return this.#withMutationLock(async () => {
      const initial = this.#proposals.review(id);
      const ids = resourceIds(initial.affectedResources);
      return this.#withResourceLocks(ids, async () => {
        const proposal = this.#proposals.review(id);
        if (
          isDestructiveOperation(proposal.operation) &&
          this.#hasPendingVerification(proposal.operation, ids)
        ) {
          throw new Error(
            'A dependent destructive change is blocked while an earlier application has pending verification'
          );
        }
        this.#proposals.recordVisualConfirmation(id, nonce);
        return this.#proposals.approve(id);
      });
    });
  }

  async #applyApproved(
    proposal: ChangeProposal,
    markApplicationOccurred: (data: unknown) => void
  ): Promise<ChangeApplicationResult> {
    const pending = this.#executors.get(proposal.id);
    if (!pending) {
      throw new Error('The proposal execution plan is unavailable');
    }
    const outcome = await this.#applyAndVerify(
      proposal.operation,
      proposal.arguments,
      pending.preflight,
      pending.execute,
      pending.refresh,
      'reviewed',
      proposal,
      (data) => {
        this.#executors.delete(proposal.id);
        markApplicationOccurred(data);
      },
      pending.persistOutcome
    );
    return {
      data: outcome.data,
      verificationState: outcome.verificationState,
      ...(outcome.verificationError ? { verificationError: outcome.verificationError } : {}),
    };
  }

  async #applyAndVerify(
    operation: string,
    arguments_: Record<string, unknown>,
    preflight: OperationPreflight,
    execute: ExecuteChangeInput['execute'],
    refresh: boolean,
    approval: 'direct' | 'reviewed',
    proposal?: ChangeProposal,
    onApplicationOccurred?: (data: unknown) => void,
    persistOutcome = true
  ): Promise<{
    data: unknown;
    verificationState: ChangeApplicationResult['verificationState'];
    verificationError?: string;
  }> {
    const data = await execute(structuredClone(arguments_), { approval });
    onApplicationOccurred?.(data);
    if (
      preflight.affectedResources.length === 0 &&
      data &&
      typeof data === 'object' &&
      typeof (data as { spreadsheetId?: unknown }).spreadsheetId === 'string'
    ) {
      const spreadsheetId = String((data as { spreadsheetId: string }).spreadsheetId);
      preflight.affectedResources.push({
        kind: 'spreadsheet',
        id: spreadsheetId,
        label: spreadsheetId,
      });
    }
    const errors: string[] = [];
    const ids = resourceIds(preflight.affectedResources);
    const pendingIds = new Set<string>();
    const clearIds = new Set<string>();
    let verified = false;
    try {
      verified = await this.#gateway.verify(operation, arguments_, data, preflight);
      if (!verified) {
        errors.push('Google state did not match the requested change');
        ids.forEach((id) => pendingIds.add(id));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      ids.forEach((id) => pendingIds.add(id));
    }
    if (refresh) {
      try {
        const refreshResult = await this.#refresh(preflight.affectedResources);
        if (this.#isChangeRefreshResult(refreshResult)) {
          for (const id of refreshResult.failedResourceIds) {
            if (ids.includes(id)) {
              pendingIds.add(id);
            }
          }
          if (verified) {
            for (const id of [
              ...refreshResult.refreshedResourceIds,
              ...refreshResult.removedResourceIds,
            ]) {
              if (ids.includes(id)) {
                clearIds.add(id);
              }
            }
          }
          const refreshErrors = Object.values(refreshResult.errors ?? {});
          if (refreshResult.failedResourceIds.length > 0) {
            errors.push(
              `Index refresh failed: ${refreshErrors.join('; ') || refreshResult.failedResourceIds.join(', ')}`
            );
          }
        } else if (verified) {
          ids.forEach((id) => clearIds.add(id));
        }
      } catch (error) {
        errors.push(
          `Index refresh failed: ${error instanceof Error ? error.message : String(error)}`
        );
        ids.forEach((id) => pendingIds.add(id));
      }
    } else if (verified) {
      ids.forEach((id) => clearIds.add(id));
    }
    for (const id of pendingIds) {
      clearIds.delete(id);
    }
    const appliedAt = new Date(this.#now()).toISOString();
    const audit: WriteAudit = {
      ...(proposal ? { proposalId: proposal.id } : {}),
      appliedAt,
      operation,
      arguments: structuredClone(arguments_),
      affectedResources: structuredClone(preflight.affectedResources),
      preview: structuredClone(preflight.preview),
      riskReasons: proposal?.riskReasons ?? [],
      approval,
      result: structuredClone(data),
      verificationState: errors.length === 0 ? 'verified' : 'applied_verification_pending',
      ...(errors.length > 0 ? { verificationError: errors.join('; ') } : {}),
    };
    if (persistOutcome) {
      try {
        this.#persistOutcome(audit, operation, [...clearIds], [...pendingIds], errors);
      } catch (error) {
        errors.push(
          `Bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`
        );
        ids.forEach((id) => {
          clearIds.delete(id);
          pendingIds.add(id);
        });
        try {
          this.#auditStore.recordPendingVerification({
            operation,
            recordedAt: appliedAt,
            affectedResourceIds: [...pendingIds],
            error: errors.join('; '),
          });
        } catch (pendingError) {
          errors.push(
            `Pending block persistence failed: ${pendingError instanceof Error ? pendingError.message : String(pendingError)}`
          );
        }
      }
    }
    const verificationState = errors.length === 0 ? 'verified' : 'applied_verification_pending';
    const verificationError = errors.join('; ');
    for (const id of clearIds) {
      this.#pendingFallback.delete(id);
    }
    for (const id of pendingIds) {
      this.#pendingFallback.add(id);
    }
    return {
      data,
      verificationState,
      ...(verificationError ? { verificationError } : {}),
    };
  }

  clearPendingVerificationBlocks(resourceIds?: readonly string[]): void {
    if (!resourceIds) {
      this.#pendingFallback.clear();
      return;
    }
    for (const id of resourceIds) {
      this.#pendingFallback.delete(id);
    }
  }

  #persistOutcome(
    audit: WriteAudit,
    operation: string,
    clearIds: string[],
    pendingIds: string[],
    errors: string[]
  ): void {
    const pending =
      pendingIds.length > 0
        ? {
            operation,
            recordedAt: audit.appliedAt,
            affectedResourceIds: pendingIds,
            error: errors.join('; '),
          }
        : undefined;
    const finalizedAudit: WriteAudit = {
      ...audit,
      verificationState: pending ? 'applied_verification_pending' : 'verified',
      ...(pending ? { verificationError: pending.error } : {}),
    };
    if (this.#auditStore.recordWriteOutcome) {
      this.#auditStore.recordWriteOutcome({
        audit: finalizedAudit,
        ...(pending ? { pending } : {}),
        ...(clearIds.length > 0 ? { clearResourceIds: clearIds } : {}),
      });
      return;
    }
    if (pending) {
      this.#auditStore.recordPendingVerification(pending);
    }
    if (clearIds.length > 0) {
      this.#auditStore.clearPendingVerifications(clearIds);
    }
    this.#auditStore.recordWriteAudit(finalizedAudit);
  }

  #isChangeRefreshResult(value: unknown): value is ChangeRefreshResult {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<ChangeRefreshResult>;
    return (
      Array.isArray(candidate.refreshedResourceIds) &&
      Array.isArray(candidate.removedResourceIds) &&
      Array.isArray(candidate.failedResourceIds)
    );
  }

  #hasPendingVerification(operation: string, ids: readonly string[]): boolean {
    const fallback =
      operation === 'sign_out'
        ? this.#pendingFallback.size > 0
        : ids.some((id) => this.#pendingFallback.has(id));
    try {
      const persisted = this.#auditStore.hasPendingVerification(
        operation === 'sign_out' ? [] : ids
      );
      return fallback || persisted;
    } catch {
      return true;
    }
  }

  #withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    return this.#withResourceLocks(['mutation:*'], action);
  }

  async #withResourceLocks<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    for (const key of [...new Set(keys)].sort()) {
      const previous = this.#locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => gate);
      this.#locks.set(key, queued);
      await previous;
      releases.push(() => {
        release();
        if (this.#locks.get(key) === queued) {
          this.#locks.delete(key);
        }
      });
    }
    try {
      return await action();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }
}
