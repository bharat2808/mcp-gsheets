import { randomBytes, randomUUID } from 'node:crypto';

import { CellValue } from '../domain/types.js';

export type ProposalStatus =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'applied_verification_pending'
  | 'cancelled'
  | 'expired';
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

export interface ValuePresentationSection {
  worksheetName: string;
  range: string;
  before: unknown[][] | Record<string, CellValue> | null;
  after: unknown[][] | Record<string, CellValue>;
}

export interface ProposalPresentationData {
  spreadsheetName: string;
  valueSections: ValuePresentationSection[];
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
  presentation?: ProposalPresentationData;
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

const FOUR_MINUTES = 4 * 60 * 1000;
const MAX_RETAINED_PROPOSALS = 256;

function equalState(first: unknown, second: unknown): boolean {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

function editedArguments(proposal: ChangeProposal, values: unknown): Record<string, unknown> {
  if (proposal.operation === 'batch_update_values') {
    if (!Array.isArray(values)) {
      throw new Error('Batch proposal edits require an ordered range list');
    }
    const sections = proposal.presentation?.valueSections ?? [];
    if (values.length !== sections.length) {
      throw new Error('Batch proposal edits must include every proposed range');
    }
    values.forEach((entry, index) => {
      const candidate = entry as { range?: unknown; values?: unknown };
      if (candidate.range !== sections[index]?.range || !Array.isArray(candidate.values)) {
        throw new Error('Batch proposal edit ranges must match the reviewed proposal');
      }
    });
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
  readonly #onPruned: (proposalIds: readonly string[]) => void;
  readonly #proposals = new Map<string, ChangeProposal>();

  constructor(
    gateway: ProposalGateway,
    now: () => number = Date.now,
    onPruned: (proposalIds: readonly string[]) => void = () => {}
  ) {
    this.#gateway = gateway;
    this.#now = now;
    this.#onPruned = onPruned;
  }

  prepare(request: ChangeRequest): ChangeProposal {
    this.#prune(1);
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
      expiresAt: new Date(createdAt + FOUR_MINUTES).toISOString(),
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
    return structuredClone(proposal);
  }

  edit(id: string, values: unknown): ChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (!proposal.editable || proposal.preview.kind !== 'values') {
      throw new Error('This structural or destructive proposal is not editable');
    }
    const arguments_ = editedArguments(proposal, values);
    const presentation = proposal.presentation
      ? structuredClone(proposal.presentation)
      : undefined;
    if (presentation) {
      if (proposal.operation === 'batch_update_values') {
        const entries = values as Array<{ values: unknown[][] }>;
        presentation.valueSections.forEach((section, index) => {
          section.after = structuredClone(entries[index]?.values ?? []);
        });
      } else if (presentation.valueSections[0]) {
        presentation.valueSections[0].after = structuredClone(
          values as unknown[][] | Record<string, CellValue>
        );
      }
    }
    proposal.preview.after = structuredClone(values);
    proposal.arguments = arguments_;
    if (presentation) proposal.presentation = presentation;
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
    this.#expireIfNeeded(proposal);
    return proposal;
  }

  #expireIfNeeded(proposal: ChangeProposal): void {
    if (proposal.status === 'pending' && this.#now() >= Date.parse(proposal.expiresAt)) {
      proposal.status = 'expired';
      proposal.visuallyConfirmed = false;
      proposal.nonce = '';
    }
  }

  #assertUsable(proposal: ChangeProposal): void {
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal is ${proposal.status}`);
    }
  }

  #prune(reservedSlots: number): void {
    const removed: string[] = [];
    for (const proposal of this.#proposals.values()) {
      this.#expireIfNeeded(proposal);
    }
    const targetSize = MAX_RETAINED_PROPOSALS - reservedSlots;
    while (this.#proposals.size > targetSize) {
      const terminal = [...this.#proposals].find(([, proposal]) => proposal.status !== 'pending');
      const oldest = terminal ?? this.#proposals.entries().next().value;
      if (!oldest) {
        break;
      }
      this.#proposals.delete(oldest[0]);
      removed.push(oldest[0]);
    }
    if (removed.length > 0) {
      this.#onPruned(removed);
    }
  }
}

export type RowChangeOperation = 'append' | 'update';
export interface RowChangeRequest {
  spreadsheetId: string;
  spreadsheetName: string;
  spreadsheetPath: string;
  sheetId: number;
  sheetTitle: string;
  operation: RowChangeOperation;
  rowNumber?: number;
  values: Record<string, CellValue>;
  expectedValues?: Record<string, CellValue>;
  displayBeforeValues?: Record<string, CellValue>;
  baseRevision: string;
}
