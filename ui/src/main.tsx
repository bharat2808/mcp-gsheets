import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useApp,
  useDocumentTheme,
  useHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/react';

import {
  PROPOSAL_ACTION_TOOLS,
  proposalActionSuccessMessage,
  proposalPresentation,
  proposalSecurityStateAfterResponse,
  proposalSecurityStateBeforeAction,
  proposalUiState,
} from './proposal-action-contract.js';
import {
  EditableTableSection,
  editableValuesForOperation,
  proposalTableModel,
  updateTableCell,
} from './proposal-table-model.js';
import './styles.css';

interface Proposal {
  version: 2;
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
  affectedResources: Array<{ kind: string; id: string; label: string }>;
  presentation?: {
    spreadsheetName: string;
    valueSections: Array<{
      worksheetName: string;
      range: string;
      before: unknown[][] | Record<string, unknown> | null;
      after: unknown[][] | Record<string, unknown>;
    }>;
  };
  preview: { kind: 'values' | 'exact'; before: unknown; after: unknown };
  riskReasons: string[];
  editable: boolean;
  status:
    | 'pending'
    | 'applying'
    | 'applied'
    | 'applied_verification_pending'
    | 'cancelled'
    | 'expired';
  verificationState: 'not_started' | 'verified' | 'applied_verification_pending';
  expiresAt: string;
  result?: { data: unknown; verificationError?: string };
}

function proposalFrom(value: unknown): Proposal | null {
  if (!value || typeof value !== 'object') return null;
  const container = value as { data?: unknown };
  const candidate = (container.data ?? value) as Partial<Proposal>;
  return candidate.version === 2 && typeof candidate.id === 'string' && candidate.preview
    ? (candidate as Proposal)
    : null;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? pretty(value) : String(value);
}

function countdown(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function ReviewApp() {
  useHostStyleVariables();
  useDocumentTheme();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [tableSections, setTableSections] = useState<EditableTableSection[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'GSheets review', version: '0.2.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (params) => {
        const next = proposalFrom(params.structuredContent);
        if (next) {
          setProposal(next);
          setTableSections(proposalTableModel(next));
          const security = proposalSecurityStateAfterResponse(
            { confirmed, confirmationToken },
            params._meta?.['gsheets/confirmationToken']
          );
          setConfirmed(security.confirmed);
          setConfirmationToken(security.confirmationToken);
        }
      };
    },
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const presentation = proposal ? proposalPresentation(proposal) : null;
  const uiState = proposal ? proposalUiState(proposal.status, proposal.expiresAt, now) : null;

  async function call(name: string, arguments_: Record<string, unknown>) {
    if (!app) return;
    const before = proposalSecurityStateBeforeAction({ confirmed, confirmationToken }, name);
    setConfirmed(before.confirmed);
    setConfirmationToken(before.confirmationToken);
    setBusy(true);
    setMessage('');
    try {
      const response = await app.callServerTool({ name, arguments: arguments_ });
      if (response.isError) throw new Error('The server rejected this action.');
      const next = proposalFrom(response.structuredContent);
      if (next) {
        setProposal(next);
        setTableSections(proposalTableModel(next));
        const security = proposalSecurityStateAfterResponse(
          { confirmed, confirmationToken },
          response._meta?.['gsheets/confirmationToken']
        );
        setConfirmed(security.confirmed);
        setConfirmationToken(security.confirmationToken);
      }
      setMessage(proposalActionSuccessMessage(name, next?.verificationState));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <main>
        <h1>Review unavailable</h1>
        <p>{error.message}</p>
      </main>
    );
  if (!isConnected)
    return (
      <main>
        <p>Connecting to GSheets…</p>
      </main>
    );
  if (!proposal || !presentation || !uiState)
    return (
      <main>
        <h1>Review change</h1>
        <p>Waiting for a proposal…</p>
      </main>
    );

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">Google Sheets</span>
          <h1>{presentation.title}</h1>
        </div>
        <span className={`status ${uiState.statusLabel.toLowerCase().replaceAll(' ', '-')}`}>
          {uiState.statusLabel}
        </span>
      </header>
      <p className="location">
        <strong>{proposal.presentation?.spreadsheetName ?? 'Google Sheets spreadsheet'}</strong>
        {proposal.status === 'pending' && !uiState.terminal ? (
          <span className="countdown"> · approval expires in {countdown(uiState.remainingMs)}</span>
        ) : null}
      </p>
      {proposal.presentation?.valueSections.length ? (
        <p className="source">
          {proposal.presentation.valueSections
            .map((section) => `${section.worksheetName} · ${section.range}`)
            .join(' | ')}
        </p>
      ) : (
        <p className="source">
          {proposal.affectedResources.map((resource) => resource.label).join(' → ')}
        </p>
      )}
      <section className="risks" aria-label="Why review is required">
        <h2>Why this needs review</h2>
        <ul>
          {proposal.riskReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>
      {presentation.editable && tableSections.length > 0 ? (
        tableSections.map((section, sectionIndex) => (
          <section className="table-section" key={`${section.range}:${sectionIndex}`}>
            <div className="table-title">
              <h2>{section.worksheetName}</h2>
              <span>{section.range}</span>
            </div>
            <div className="table-comparison">
              <div>
                <h3>Before</h3>
                <div className="table-scroll">
                  <table className="value-table">
                    <thead>
                      <tr>
                        <th aria-label="Row number">#</th>
                        {section.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.before.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <th>{rowIndex + 1}</th>
                          {row.map((cell, columnIndex) => (
                            <td className="before-cell" key={columnIndex}>
                              {cellText(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3>Proposed</h3>
                <div className="table-scroll">
                  <table className="value-table">
                    <thead>
                      <tr>
                        <th aria-label="Row number">#</th>
                        {section.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.after.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          <th>{rowIndex + 1}</th>
                          {row.map((cell, columnIndex) => (
                            <td className="after-cell" key={columnIndex}>
                              <input
                                aria-label={`${section.worksheetName} ${section.range} row ${rowIndex + 1} column ${section.columns[columnIndex]}`}
                                value={cellText(cell)}
                                disabled={busy || uiState.terminal}
                                onChange={(event) => {
                                  setTableSections((current) =>
                                    updateTableCell(
                                      current,
                                      sectionIndex,
                                      rowIndex,
                                      columnIndex,
                                      event.target.value
                                    )
                                  );
                                  setConfirmed(false);
                                }}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        ))
      ) : (
        <section>
          <div className="preview-grid">
            <div>
              <h2>Before</h2>
              <pre>{pretty(proposal.preview.before)}</pre>
            </div>
            <div>
              <h2>After</h2>
              <pre>{pretty(proposal.preview.after)}</pre>
            </div>
          </div>
        </section>
      )}
      <>
        <label className="confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || uiState.terminal}
            onChange={(event) => setConfirmed(event.target.checked)}
          />{' '}
          I reviewed the before and after state and want to apply this exact change.
        </label>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy || uiState.terminal}
            onClick={() => call(PROPOSAL_ACTION_TOOLS.cancel, { proposalId: proposal.id })}
          >
            Cancel
          </button>
          {presentation.editable && (
            <button
              className="secondary"
              disabled={busy || uiState.terminal}
              onClick={() => {
                const values = editableValuesForOperation(proposal.operation, tableSections);
                void call(PROPOSAL_ACTION_TOOLS.edit, { proposalId: proposal.id, values });
              }}
            >
              Save edits
            </button>
          )}
          <button
            disabled={busy || uiState.terminal || !confirmed || !confirmationToken}
            onClick={() =>
              call(PROPOSAL_ACTION_TOOLS.approve, { proposalId: proposal.id, confirmationToken })
            }
          >
            Apply change
          </button>
        </div>
      </>
      {proposal.verificationState === 'applied_verification_pending' && (
        <p className="message pending" role="alert">
          Applied, but verification is pending. Dependent destructive work is blocked until refresh
          succeeds.
          {proposal.result?.verificationError ? ` ${proposal.result.verificationError}` : ''}
        </p>
      )}
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<ReviewApp />);
