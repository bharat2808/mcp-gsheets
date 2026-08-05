import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useApp,
  useDocumentTheme,
  useHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/react';

import { PROPOSAL_ACTION_TOOLS, proposalActionSuccessMessage } from './proposal-action-contract.js';
import './styles.css';

type CellValue = string | number | boolean | null;
interface Proposal {
  id: string;
  spreadsheetId: string;
  spreadsheetName: string;
  spreadsheetPath: string;
  sheetTitle: string;
  operation: 'append' | 'update';
  rowNumber?: number;
  values: Record<string, CellValue>;
  expectedValues?: Record<string, CellValue>;
  displayBeforeValues?: Record<string, CellValue>;
  status: 'pending' | 'applied' | 'cancelled';
  expiresAt: string;
  result?: { updatedRange: string; verified?: boolean };
}

function proposalFrom(value: unknown): Proposal | null {
  if (!value || typeof value !== 'object') return null;
  const container = value as { data?: unknown };
  const candidate = (container.data ?? value) as Partial<Proposal>;
  return typeof candidate.id === 'string' && typeof candidate.values === 'object'
    ? (candidate as Proposal)
    : null;
}

function ReviewApp() {
  useHostStyleVariables();
  useDocumentTheme();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState<Record<string, CellValue>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [confirmationToken, setConfirmationToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'GSheets review', version: '0.1.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (params) => {
        const next = proposalFrom(params.structuredContent);
        if (next) {
          setProposal(next);
          setDraft(next.values);
          setConfirmed(false);
        }
        const token = params._meta?.['gsheets/confirmationToken'];
        if (typeof token === 'string') setConfirmationToken(token);
      };
    },
  });

  const expires = useMemo(
    () => (proposal ? new Date(proposal.expiresAt).toLocaleTimeString() : ''),
    [proposal]
  );

  async function call(name: string, arguments_: Record<string, unknown>) {
    if (!app) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await app.callServerTool({ name, arguments: arguments_ });
      if (response.isError) throw new Error('The server rejected this action.');
      const next = proposalFrom(response.structuredContent);
      if (next) {
        setProposal(next);
        setDraft(next.values);
      }
      const token = response._meta?.['gsheets/confirmationToken'];
      if (typeof token === 'string') setConfirmationToken(token);
      setMessage(proposalActionSuccessMessage(name, next?.result?.verified));
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
  if (!proposal)
    return (
      <main>
        <h1>Review Sheet change</h1>
        <p>Waiting for a proposal…</p>
      </main>
    );

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">Google Sheets</span>
          <h1>
            {proposal.operation === 'append' ? 'Append row' : `Update row ${proposal.rowNumber}`}
          </h1>
        </div>
        <span className={`status ${proposal.status}`}>{proposal.status}</span>
      </header>
      <p className="location">
        {proposal.spreadsheetName} → {proposal.sheetTitle}
        {proposal.rowNumber ? ` → row ${proposal.rowNumber}` : ''} · expires at {expires}
      </p>
      <p className="source">
        Source: {proposal.spreadsheetPath} · Google file {proposal.spreadsheetId}
      </p>
      <section>
        <div className="grid heading">
          <span>Column</span>
          <span>Current</span>
          <span>Proposed</span>
        </div>
        {Object.entries(draft).map(([key, value]) => (
          <div className="grid" key={key}>
            <strong>{key}</strong>
            <span className="old">
              {String(proposal.displayBeforeValues?.[key] ?? proposal.expectedValues?.[key] ?? '—')}
            </span>
            {typeof value === 'boolean' ? (
              <select
                aria-label={`Proposed ${key}`}
                value={String(value)}
                onChange={(event) => {
                  setDraft({ ...draft, [key]: event.target.value === 'true' });
                  setConfirmed(false);
                }}
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            ) : (
              <input
                aria-label={`Proposed ${key}`}
                type={typeof value === 'number' ? 'number' : 'text'}
                value={value === null ? '' : String(value)}
                onChange={(event) => {
                  const nextValue =
                    typeof value === 'number'
                      ? event.target.value === ''
                        ? null
                        : Number(event.target.value)
                      : event.target.value;
                  setDraft({ ...draft, [key]: nextValue });
                  setConfirmed(false);
                }}
              />
            )}
          </div>
        ))}
      </section>
      {proposal.status === 'pending' && (
        <>
          <label className="confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I reviewed every value and want to apply this exact change.
          </label>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => call(PROPOSAL_ACTION_TOOLS.cancel, { proposalId: proposal.id })}
            >
              Cancel
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                call(PROPOSAL_ACTION_TOOLS.edit, { proposalId: proposal.id, values: draft })
              }
            >
              Save edits
            </button>
            <button
              disabled={busy || !confirmed || !confirmationToken}
              onClick={() =>
                call(PROPOSAL_ACTION_TOOLS.approve, { proposalId: proposal.id, confirmationToken })
              }
            >
              Apply to Google Sheets
            </button>
          </div>
        </>
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
