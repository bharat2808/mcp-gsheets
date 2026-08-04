import { randomBytes, randomUUID } from 'node:crypto';

import { CellValue } from '../domain/types.js';

export type SheetChangeOperation = 'append' | 'update';
export type ProposalStatus = 'pending' | 'applied' | 'cancelled';

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
  baseRevision: string;
}

export interface SheetChangeProposal extends SheetChangeRequest {
  id: string;
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  visuallyConfirmed: boolean;
  result?: { updatedRange: string; verified?: boolean };
}

export interface ProposalGateway {
  getRevision(spreadsheetId: string): Promise<string>;
  readRow(request: SheetChangeProposal): Promise<Record<string, CellValue>>;
  apply(proposal: SheetChangeProposal): Promise<{ updatedRange: string; verified?: boolean }>;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function equalValues(
  first: Record<string, CellValue> | undefined,
  second: Record<string, CellValue>
): boolean {
  return JSON.stringify(first ?? {}) === JSON.stringify(second);
}

function assertSafeValues(values: Record<string, CellValue>): void {
  if (
    Object.values(values).some(
      (value) => typeof value === 'string' && value.trimStart().startsWith('=')
    )
  ) {
    throw new Error('Formula values are not supported');
  }
}

export class ProposalManager {
  readonly #gateway: ProposalGateway;
  readonly #now: () => number;
  readonly #proposals = new Map<string, SheetChangeProposal>();
  readonly #confirmationTokens = new Map<string, string>();

  constructor(gateway: ProposalGateway, now: () => number = Date.now) {
    this.#gateway = gateway;
    this.#now = now;
  }

  prepare(request: SheetChangeRequest): SheetChangeProposal {
    if (request.operation === 'update' && !request.rowNumber) {
      throw new Error('An update proposal requires a row number');
    }
    if (Object.keys(request.values).length === 0) {
      throw new Error('A proposal requires values');
    }
    assertSafeValues(request.values);
    const createdAt = this.#now();
    const proposal: SheetChangeProposal = {
      ...request,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + FIFTEEN_MINUTES).toISOString(),
      visuallyConfirmed: false,
    };
    this.#proposals.set(proposal.id, proposal);
    this.#confirmationTokens.set(proposal.id, randomBytes(32).toString('base64url'));
    return structuredClone(proposal);
  }

  confirmationToken(id: string): string {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    const token = this.#confirmationTokens.get(id);
    if (!token) {
      throw new Error('Proposal confirmation token is unavailable');
    }
    return token;
  }

  review(id: string): SheetChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    return structuredClone(proposal);
  }

  edit(id: string, values: Record<string, CellValue>): SheetChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (Object.keys(values).length === 0) {
      throw new Error('A proposal requires values');
    }
    assertSafeValues(values);
    proposal.values = structuredClone(values);
    proposal.visuallyConfirmed = false;
    this.#confirmationTokens.set(proposal.id, randomBytes(32).toString('base64url'));
    return structuredClone(proposal);
  }

  recordVisualConfirmation(id: string, confirmationToken: string): SheetChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (confirmationToken !== this.#confirmationTokens.get(id)) {
      throw new Error('The app confirmation token did not match');
    }
    proposal.visuallyConfirmed = true;
    return structuredClone(proposal);
  }

  cancel(id: string): SheetChangeProposal {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    proposal.status = 'cancelled';
    this.#confirmationTokens.delete(id);
    return structuredClone(proposal);
  }

  async approve(id: string): Promise<SheetChangeProposal> {
    const proposal = this.#required(id);
    this.#assertUsable(proposal);
    if (!proposal.visuallyConfirmed) {
      throw new Error('The proposal requires visual confirmation in the app before approval');
    }
    const revision = await this.#gateway.getRevision(proposal.spreadsheetId);
    if (revision !== proposal.baseRevision) {
      throw new Error('The spreadsheet revision changed; refresh and prepare a new proposal');
    }
    if (proposal.operation === 'update') {
      const current = await this.#gateway.readRow(proposal);
      if (!equalValues(proposal.expectedValues, current)) {
        throw new Error('The target row changed; refresh and prepare a new proposal');
      }
    }
    proposal.result = await this.#gateway.apply(structuredClone(proposal));
    proposal.status = 'applied';
    this.#confirmationTokens.delete(id);
    return structuredClone(proposal);
  }

  #required(id: string): SheetChangeProposal {
    const proposal = this.#proposals.get(id);
    if (!proposal) {
      throw new Error(`Unknown proposal: ${id}`);
    }
    return proposal;
  }

  #assertUsable(proposal: SheetChangeProposal): void {
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal is ${proposal.status}`);
    }
    if (this.#now() > Date.parse(proposal.expiresAt)) {
      throw new Error('Proposal has expired');
    }
  }
}
