import { randomBytes, randomUUID } from 'node:crypto';

import { CellValue } from '../domain/types.js';

export type ProposalStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'applied_verification_pending'
  | 'cancelled';
export type VerificationState = 'not_started' | 'verified' | 'applied_verification_pending';
export type ProposalPreviewKind = 'values' | 'exact';
export type ResourceKind = 'account' | 'spreadsheet' | 'sheet' | 'range' | 'chart' | 'table';

export interface AffectedResource {
  kind: ResourceKind;
  id: string;
  label: string;
}

export interface ChangePreview {
  kind: ProposalPreviewKind;
  before: unknown;
  after: unknown;
}

export interface ChangeApplicationResult {
  data: unknown;
  verificationState: Exclude<VerificationState, 'not_started'>;
  verificationError?: string;
}

export interface ChangeRequest {
  operation: string;
  arguments: Record<string, unknown>;
  affectedResources: AffectedResource[];
  preview: ChangePreview;
  riskReasons: string[];
  driveRevisions: Record<string, string>;
  editable: boolean;
  preflightState?: unknown;
}

export interface ChangeProposal extends ChangeRequest {
  version: 2;
  id: string;
  nonce: string;
  status: ProposalStatus;
  verificationState: VerificationState;
  createdAt: string;
  expiresAt: string;
  visuallyConfirmed: boolean;
  result?: ChangeApplicationResult;
}

export type PublicChangeProposal = Omit<ChangeProposal, 'nonce' | 'preflightState'>;

export interface ProposalGateway {
  getRevisions(proposal: ChangeProposal): Promise<Record<string, string>>;
  captureState(proposal: ChangeProposal): Promise<unknown>;
  apply(
    proposal: ChangeProposal,
    markApplicationOccurred: (data: unknown) => void
  ): Promise<ChangeApplicationResult>;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function equalState(first: unknown, second: unknown): boolean {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

function editedArguments(proposal: ChangeProposal, values: unknown): Record<string, unknown> {
  if (proposal.operation === 'batch_update_values') {
    return { ...proposal.arguments, data: structuredClone(values) };
  }
  if (proposal.operation === 'prepare_row_change') {
    return { ...proposal.arguments, values: structuredClone(values) };
  }
  return { ...proposal.arguments, values: structuredClone(values) };
}

export function publicChangeProposal(proposal: ChangeProposal): PublicChangeProposal {
  const { nonce: _nonce, preflightState: _preflightState, ...publicProposal } = proposal;
  return structuredClone(publicProposal);
}

export class ProposalManager {
  readonly #gateway: ProposalGateway;
  readonly #now: () => number;
  readonly #proposals = new Map<string, ChangeProposal>();

  constructor(gateway: ProposalGateway, now: () => number = Date.now) {
    this.#gateway = gateway;
    this.#now = now;
  }

  prepare(request: ChangeRequest): ChangeProposal {
    if (!request.operation.trim()) {
      throw new Error('A proposal requires an operation');
    }
    if (request.riskReasons.length === 0) {
      throw new Error('A proposal requires a risk reason');
    }
    if (request.editable !== (request.preview.kind === 'values')) {
      throw new Error('Only value proposals may be editable');
    }
    const createdAt = this.#now();
    const proposal: ChangeProposal = {
      ...structuredClone(request),
      version: 2,
      id: randomUUID(),
      nonce: randomBytes(32).toString('base64url'),
      status: 'pending',
      verificationState: 'not_started',
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + FIFTEEN_MINUTES).toISOString(),
      visuallyConfirmed: false,
    };
    this.#proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  confirmationToken(id: string): string {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    return proposal.nonce;
  }

  review(id: string): ChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    return structuredClone(proposal);
  }

  edit(id: string, values: unknown): ChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (!proposal.editable || proposal.preview.kind !== 'values') {
      throw new Error('This structural or destructive proposal is not editable');
    }
    proposal.preview.after = structuredClone(values);
    proposal.arguments = editedArguments(proposal, values);
    proposal.visuallyConfirmed = false;
    proposal.nonce = randomBytes(32).toString('base64url');
    return structuredClone(proposal);
  }

  recordVisualConfirmation(id: string, confirmationToken: string): ChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (confirmationToken !== proposal.nonce) {
      throw new Error('The app confirmation token did not match');
    }
    proposal.visuallyConfirmed = true;
    return structuredClone(proposal);
  }

  cancel(id: string): ChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    proposal.status = 'cancelled';
    proposal.nonce = '';
    return structuredClone(proposal);
  }

  async approve(id: string): Promise<ChangeProposal> {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (!proposal.visuallyConfirmed) {
      throw new Error('The proposal requires visual confirmation in the app before approval');
    }
    proposal.status = 'applying';
    proposal.nonce = '';
    let applicationOccurred = false;
    const markApplicationOccurred = (data: unknown) => {
      if (applicationOccurred) {
        return;
      }
      applicationOccurred = true;
      proposal.status = 'applied_verification_pending';
      proposal.verificationState = 'applied_verification_pending';
      proposal.result = {
        data: structuredClone(data),
        verificationState: 'applied_verification_pending',
      };
    };
    try {
      const revisions = await this.#gateway.getRevisions(structuredClone(proposal));
      if (!equalState(proposal.driveRevisions, revisions)) {
        throw new Error('A spreadsheet revision changed; refresh and prepare a new proposal');
      }
      const state = await this.#gateway.captureState(structuredClone(proposal));
      if (!equalState(proposal.preflightState, state)) {
        throw new Error('The target state changed; refresh and prepare a new proposal');
      }
      const result = await this.#gateway.apply(structuredClone(proposal), markApplicationOccurred);
      if (!applicationOccurred) {
        markApplicationOccurred(result.data);
      }
      proposal.result = result;
    } catch (error) {
      if (!applicationOccurred) {
        proposal.status = 'pending';
        proposal.verificationState = 'not_started';
        proposal.visuallyConfirmed = false;
        proposal.nonce = randomBytes(32).toString('base64url');
        delete proposal.result;
        throw error;
      }
      proposal.result = {
        data: proposal.result?.data,
        verificationState: 'applied_verification_pending',
        verificationError: error instanceof Error ? error.message : String(error),
      };
    }
    proposal.verificationState = proposal.result.verificationState;
    proposal.status =
      proposal.verificationState === 'verified' ? 'applied' : 'applied_verification_pending';
    return structuredClone(proposal);
  }

  #required(id: string): ChangeProposal {
    const proposal = this.#proposals.get(id);
    if (!proposal) {
      throw new Error(`Unknown proposal: ${id}`);
    }
    return proposal;
  }

  #assertUsable(proposal: ChangeProposal): void {
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal is ${proposal.status}`);
    }
    if (this.#now() > Date.parse(proposal.expiresAt)) {
      throw new Error('Proposal has expired');
    }
  }
}

// Transitional aliases retained for callers that still describe row proposals.
export type SheetChangeOperation = 'append' | 'update';
export interface SheetChangeRequest {
  spreadsheetId: string;
  spreadsheetName: string;
  spreadsheetPath: string;
  sheetId: number;
  sheetTitle: string;
  operation: SheetChangeOperation;
  rowNumber?: number;
  values: Record<string, CellValue>;
  expectedValues?: Record<string, CellValue>;
  displayBeforeValues?: Record<string, CellValue>;
  baseRevision: string;
}
export type SheetChangeProposal = ChangeProposal;
