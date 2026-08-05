import { WriteAudit } from '../domain/types.js';
import {
  AffectedResource,
  ChangeApplicationResult,
  ChangePreview,
  ChangeProposal,
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
}

export interface ChangeWorkflowDependencies {
  gateway: ChangeWorkflowGateway;
  auditStore: ChangeAuditStore;
  refresh: (affectedResources: readonly AffectedResource[]) => Promise<unknown>;
  now?: () => number;
}

export interface ExecuteChangeInput {
  operation: string;
  arguments: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>) => Promise<unknown>;
  refresh?: boolean;
  preflight?: OperationPreflight;
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
    { execute: ExecuteChangeInput['execute']; refresh: boolean; preflight: OperationPreflight }
  >();
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
        apply: (proposal) => this.#applyApproved(proposal),
      },
      this.#now
    );
  }

  async execute(input: ExecuteChangeInput): Promise<ChangeWorkflowOutcome> {
    const preflight =
      input.preflight ?? (await this.#gateway.inspect(input.operation, input.arguments));
    const ids = resourceIds(preflight.affectedResources);
    if (
      isDestructiveOperation(input.operation) &&
      this.#auditStore.hasPendingVerification(input.operation === 'sign_out' ? [] : ids)
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
        preflightState: preflight.state,
      });
      this.#executors.set(proposal.id, {
        execute: input.execute,
        refresh: input.refresh !== false,
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
      'direct'
    );
    return { kind: 'direct', ...application };
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
    const proposal = this.#proposals.review(id);
    const ids = resourceIds(proposal.affectedResources);
    if (
      isDestructiveOperation(proposal.operation) &&
      this.#auditStore.hasPendingVerification(proposal.operation === 'sign_out' ? [] : ids)
    ) {
      throw new Error(
        'A dependent destructive change is blocked while an earlier application has pending verification'
      );
    }
    this.#proposals.recordVisualConfirmation(id, nonce);
    const applied = await this.#proposals.approve(id);
    this.#executors.delete(id);
    return applied;
  }

  async #applyApproved(proposal: ChangeProposal): Promise<ChangeApplicationResult> {
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
      proposal
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
    proposal?: ChangeProposal
  ): Promise<{
    data: unknown;
    verificationState: ChangeApplicationResult['verificationState'];
    verificationError?: string;
  }> {
    const data = await execute(structuredClone(arguments_));
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
    try {
      if (!(await this.#gateway.verify(operation, arguments_, data, preflight))) {
        errors.push('Google state did not match the requested change');
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (refresh) {
      try {
        await this.#refresh(preflight.affectedResources);
      } catch (error) {
        errors.push(
          `Index refresh failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const ids = resourceIds(preflight.affectedResources);
    const verificationState = errors.length === 0 ? 'verified' : 'applied_verification_pending';
    const verificationError = errors.join('; ');
    if (verificationState === 'verified') {
      this.#auditStore.clearPendingVerifications(ids);
    } else {
      this.#auditStore.recordPendingVerification({
        operation,
        recordedAt: new Date(this.#now()).toISOString(),
        affectedResourceIds: ids,
        error: verificationError,
      });
    }
    this.#auditStore.recordWriteAudit({
      ...(proposal ? { proposalId: proposal.id } : {}),
      appliedAt: new Date(this.#now()).toISOString(),
      operation,
      arguments: structuredClone(arguments_),
      affectedResources: structuredClone(preflight.affectedResources),
      preview: structuredClone(preflight.preview),
      riskReasons: proposal?.riskReasons ?? [],
      approval,
      result: structuredClone(data),
      verificationState,
      ...(verificationError ? { verificationError } : {}),
    });
    return {
      data,
      verificationState,
      ...(verificationError ? { verificationError } : {}),
    };
  }
}
