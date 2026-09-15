import { useEffect, useRef, useState } from 'react';
import type { Actor, ApprovalInput, Entry, ImportDetail, ImportInput, ImportResult, Kind, Workbench } from '../shared.ts';
import { decodeCsv } from './read-csv.ts';

const empty: Workbench = { imports: [], entries: [], resolutions: [], audit: [] };
const money = (minor: string) => {
  const cents = BigInt(minor);
  return `€${(cents / 100n).toLocaleString('en-IE')}.${(cents % 100n).toString().padStart(2, '0')}`;
};
const when = (value: string) => new Date(value).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Try again.';
type View = 'review' | 'imports' | 'audit';

function ReviewRow({ payment, invoices, payments, disabled, onApprove, onSource }: {
  payment: Entry; invoices: Entry[]; payments: Entry[]; disabled: boolean;
  onApprove: (input: ApprovalInput) => Promise<void>; onSource: (entry: Entry) => void;
}) {
  const equalAmounts = invoices.filter(invoice => invoice.amountMinor === payment.amountMinor);
  const exact = equalAmounts.filter(invoice => invoice.reference === payment.reference);
  const candidateHasConflict = payment.conflictSourceRowIds.length > 0 || exact.some(invoice => invoice.conflictSourceRowIds.length > 0);
  const unique = !candidateHasConflict && exact.length === 1 && payments.filter(item => item.reference === payment.reference && item.amountMinor === payment.amountMinor).length === 1;
  const [invoiceId, setInvoiceId] = useState(unique ? exact[0].id : '');
  const [note, setNote] = useState('');
  const invoice = equalAmounts.find(item => item.id === invoiceId);
  const inspectedInvoices = invoice ? [invoice] : exact;
  const hasSourceConflict = payment.conflictSourceRowIds.length > 0 || inspectedInvoices.some(item => item.conflictSourceRowIds.length > 0);
  const isExact = unique && (!invoice || invoice.reference === payment.reference);
  const needsNote = Boolean(invoice && (invoice.reference !== payment.reference || !unique || invoice.conflictSourceRowIds.length));
  const ambiguous = exact.length > 0 && !unique && (!invoice || invoice.reference === payment.reference);
  const reason = hasSourceConflict ? 'Conflicting source values — inspect and explain the retained amount' : isExact ? 'Reference and amount agree' : ambiguous ? 'More than one possible match — choose and explain' : equalAmounts.length ? 'Amount agrees; reference needs review' : 'No open invoice for this full amount';
  const status = hasSourceConflict ? 'Source conflict' : isExact ? 'Exact candidate' : ambiguous ? 'Ambiguous' : equalAmounts.length ? 'Reference exception' : 'Unresolved amount';

  return <article className={`review-row ${isExact && !hasSourceConflict ? 'exact' : ''}`}>
    <div className="review-status"><span className={`pill ${isExact && !hasSourceConflict ? 'teal' : 'amber'}`}>{status}</span><span>{reason}</span></div>
    {hasSourceConflict && <div className="conflict-evidence"><p>The first accepted values are retained. Conflicting rows do not replace them. Inspect the evidence and explain why this allocation uses the retained amount.</p>{payment.conflictSourceRowIds.map(id => <button key={id} className="source-link" onClick={() => onSource({ ...payment, sourceRowId: id })}>Inspect payment conflict ↗</button>)}{inspectedInvoices.flatMap(entry => entry.conflictSourceRowIds.map(id => <button key={id} className="source-link" onClick={() => onSource({ ...entry, sourceRowId: id })}>Inspect invoice conflict ↗</button>))}</div>}
    <div className="reconciliation-pair">
      <div className="entry-card"><span className="eyebrow">Payment</span><strong className="entry-amount">{money(payment.amountMinor)}</strong><span className="reference">{payment.reference}</span><button className="source-link" onClick={() => onSource(payment)}>{payment.externalId} <span aria-hidden="true">↗</span><span className="sr-only"> source row</span></button></div>
      <span className="pair-bridge" aria-hidden="true">→</span>
      <div className="entry-card invoice-choice"><label className="eyebrow" htmlFor={`invoice-${payment.id}`}>Invoice · equal amount only</label>{equalAmounts.length ? <><select id={`invoice-${payment.id}`} value={invoice?.id ?? ''} onChange={event => setInvoiceId(event.target.value)} disabled={disabled}><option value="">Choose an invoice</option>{equalAmounts.map(item => <option key={item.id} value={item.id}>{item.reference} · {money(item.amountMinor)} · {item.externalId}</option>)}</select>{invoice && <button className="source-link" onClick={() => onSource(invoice)}>{invoice.externalId} <span aria-hidden="true">↗</span><span className="sr-only"> source row</span></button>}</> : <><strong className="unmatched-label">Keep open</strong><p>Partial payments and unequal amounts stay unresolved.</p></>}</div>
      <div className="decision"><label htmlFor={`note-${payment.id}`}>Review note {needsNote ? <span className="required">required</span> : <span className="optional">optional</span>}</label><textarea id={`note-${payment.id}`} rows={2} value={note} onChange={event => setNote(event.target.value)} disabled={disabled || !invoice} placeholder={needsNote ? 'Explain the reference or choice (10+ characters)' : 'Add context for the audit record'} maxLength={500} /><button className="primary" disabled={disabled || !invoice || (needsNote && note.trim().length < 10)} onClick={() => void onApprove({ paymentId: payment.id, invoiceId: invoice!.id, note })}>Approve match <span aria-hidden="true">↗</span></button></div>
    </div>
  </article>;
}

export default function App() {
  const [tokenInput, setTokenInput] = useState('');
  const [token, setToken] = useState('');
  const [actor, setActor] = useState<Actor | null>(null);
  const [data, setData] = useState<Workbench>(empty);
  const [view, setView] = useState<View>('review');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [kind, setKind] = useState<Kind>('invoice');
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState('');
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [sourceId, setSourceId] = useState('');
  const details = useRef(new Map<string, ImportDetail>());
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canWrite = actor?.role === 'reviewer';
  const invoices = data.entries.filter(entry => entry.kind === 'invoice' && !data.resolutions.some(resolution => resolution.invoiceId === entry.id));
  const payments = data.entries.filter(entry => entry.kind === 'payment' && !data.resolutions.some(resolution => resolution.paymentId === entry.id));
  const totalApproved = data.resolutions.reduce((total, resolution) => total + BigInt(resolution.amountMinor), 0n).toString();
  const heldRows = data.imports.reduce((total, batch) => total + batch.counts.conflict + batch.counts.rejected, 0);

  useEffect(() => {
    if (detail && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (detail && sourceId) document.getElementById(`source-${sourceId}`)?.scrollIntoView({ block: 'nearest' });
  }, [detail, sourceId]);

  async function api<T>(path: string, init?: RequestInit, accessToken = token): Promise<T> {
    const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...init?.headers }, cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
    return payload;
  }

  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setNotice(null);
    try { await action(); } catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }); }
    finally { setBusy(''); }
  }

  async function connect(accessToken: string) {
    await perform('Connecting', async () => {
      const session = await api<{ actor: Actor }>('/api/session', undefined, accessToken);
      const workbench = await api<Workbench>('/api/workbench', undefined, accessToken);
      setToken(accessToken); setTokenInput(''); setData(workbench); setActor(session.actor);
    });
  }

  async function getDetail(id: string): Promise<ImportDetail> {
    const cached = details.current.get(id);
    if (cached) return cached;
    const result = await api<ImportDetail>(`/api/imports/${encodeURIComponent(id)}`);
    details.current.set(id, result);
    return result;
  }

  async function inspectImport(id: string) {
    await perform('Loading source', async () => { setSourceId(''); setDetail(await getDetail(id)); });
  }

  async function inspectSource(entry: Entry) {
    await perform('Loading source', async () => {
      // ponytail: scan cached batches in this small sandbox; add a row endpoint if import volume grows.
      for (const batch of data.imports.filter(item => item.kind === entry.kind)) {
        const result = await getDetail(batch.id);
        if (result.rows.some(row => row.id === entry.sourceRowId)) { setSourceId(entry.sourceRowId); setDetail(result); return; }
      }
      throw new Error('The source row was not found. Refresh the workbench and try again.');
    });
  }

  async function loadSample(sampleKind: Kind) {
    await perform('Loading sample', async () => {
      const name = `${sampleKind}s.csv`;
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error('The sample file could not be loaded. Try its download link.');
      setCsv(await response.text()); setFilename(name); setKind(sampleKind); setKey(`sample-${sampleKind}s-v1`);
      if (fileInput.current) fileInput.current.value = '';
      setView('imports');
    });
  }

  async function importCsv(event: React.SubmitEvent) {
    event.preventDefault();
    await perform('Importing CSV', async () => {
      const input: ImportInput = { kind, filename, csv, idempotencyKey: key };
      const result = await api<ImportResult>('/api/imports', { method: 'POST', body: JSON.stringify(input) });
      setData(await api<Workbench>('/api/workbench'));
      setNotice({ kind: 'success', text: result.replayed ? 'This delivery was already imported. Its original result is shown; no rows were added.' : `${filename} imported: ${result.batch.counts.accepted} accepted, ${result.batch.counts.duplicate} duplicate, ${result.batch.counts.rejected} rejected, ${result.batch.counts.conflict} conflicting.` });
      setSourceId(''); setDetail(await getDetail(result.batch.id));
    });
  }

  async function approve(input: ApprovalInput) {
    await perform('Approving match', async () => {
      await api('/api/approvals', { method: 'POST', body: JSON.stringify(input) });
      setData(await api<Workbench>('/api/workbench'));
      setNotice({ kind: 'success', text: 'Match approved and recorded in audit history.' });
    });
  }

  function downloadSource() {
    if (!detail) return;
    const url = URL.createObjectURL(new Blob([detail.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = detail.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <a className="skip-link" href="#main">Skip to workspace</a>
    <header className="app-header">
      <span className="brand">Inception</span>
      {actor && <div className="header-right">
        <span className="actor">{actor.id}<span>{actor.role}</span></span>
        <button className="quiet" disabled={Boolean(busy)} onClick={() => {
          setActor(null); setToken(''); setData(empty); setDetail(null);
          details.current.clear(); setNotice(null);
        }}>Disconnect</button>
      </div>}
    </header>
    <p className="sandbox-notice">Shared synthetic sandbox · EUR only · No real client data or money movement.</p>
    {!actor ? <main id="main" className="access-panel">
      <h1>Reconciliation workbench</h1>
      <p>Reviewers can import and approve. Viewers can inspect.</p>
      <button className="primary" disabled={Boolean(busy)} onClick={() => void connect('')}>
        {busy ? 'Connecting…' : 'Open local sandbox'}
      </button>
      <p className="field-help">Requires local demo access on this computer.</p>
      <form onSubmit={event => { event.preventDefault(); void connect(tokenInput.trim()); }}>
        <label htmlFor="access-key">Or use an access key</label>
        <input id="access-key" type="password" autoComplete="off" value={tokenInput}
          onChange={event => setTokenInput(event.target.value)} required />
        <p className="field-help">Kept in tab memory. Refreshing disconnects you.</p>
        {notice && <p className="notice error" role="alert">{notice.text}</p>}
        <button className="secondary" disabled={Boolean(busy) || !tokenInput.trim()}>
          {busy ? 'Connecting…' : 'Open with access key'}
        </button>
      </form>
      <div className="sample-links">
        <a href="/samples/invoices.csv" download>Invoice sample ↓</a>
        <a href="/samples/payments.csv" download>Payment sample ↓</a>
      </div>
    </main> : <>
      <div className="workspace-bar"><nav aria-label="Workspace"><button className={view === 'review' ? 'active' : ''} aria-current={view === 'review' ? 'page' : undefined} onClick={() => setView('review')}>Reconcile <span>{payments.length}</span></button><button className={view === 'imports' ? 'active' : ''} aria-current={view === 'imports' ? 'page' : undefined} onClick={() => setView('imports')}>Imports <span>{data.imports.length}</span></button><button className={view === 'audit' ? 'active' : ''} aria-current={view === 'audit' ? 'page' : undefined} onClick={() => setView('audit')}>Audit history</button></nav><button className="quiet refresh" disabled={Boolean(busy)} onClick={() => void perform('Refreshing', async () => { setData(await api<Workbench>('/api/workbench')); setNotice({ kind: 'success', text: 'Workbench refreshed.' }); })}><span aria-hidden="true">↻</span> Refresh</button></div>
      <main id="main" className="workspace">
        <div className="page-heading">
          <h1>{view === 'review' ? 'Reconciliation' : view === 'imports' ? 'Imports' : 'Audit history'}</h1>
          {view === 'review' && <button className="primary" onClick={() => setView('imports')}>Import CSV</button>}
        </div>
        {!canWrite && <p className="viewer-notice">Viewer access · You can inspect sources and decisions. Imports and approvals require a reviewer key.</p>}
        <div aria-live="polite" className="feedback">{busy && <p className="busy"><span className="spinner" aria-hidden="true" /> {busy}…</p>}{notice && <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></p>}</div>
        <section className="metrics" aria-label="Reconciliation summary"><div><span>Open payments</span><strong>{payments.length}</strong></div><div><span>Open invoices</span><strong>{invoices.length}</strong></div><div><span>Approved amount</span><strong className="money">{money(totalApproved)}</strong><small>{data.resolutions.length} approved {data.resolutions.length === 1 ? 'match' : 'matches'}</small></div><div><span>Source exceptions</span><strong className={heldRows ? 'amber-text' : ''}>{heldRows}</strong><small>Rejected or conflicting rows</small></div></section>
        {view === 'review' && <>
          <section className="review-section"><div className="section-heading"><h2>Payment review <span className="count">{payments.length}</span></h2><p>Every allocation needs approval</p></div>{payments.length ? payments.map(payment => <ReviewRow key={payment.id} payment={payment} invoices={invoices} payments={payments} disabled={!canWrite || Boolean(busy)} onApprove={approve} onSource={entry => void inspectSource(entry)} />) : <div className="empty-state"><h3>No payments to review</h3><p>{data.entries.length ? 'Import another payment CSV to continue.' : 'Import invoice and payment CSVs, or load the samples.'}</p><button className="primary" onClick={() => setView('imports')}>Go to imports <span aria-hidden="true">→</span></button></div>}</section>
          <section className="panel"><div className="section-heading"><h2>Open invoices <span className="count">{invoices.length}</span></h2><p>Full amount allocation only</p></div>{invoices.length ? <div className="table-scroll"><table><caption className="sr-only">Open invoices and their preserved source</caption><thead><tr><th>Invoice</th><th>Reference</th><th className="align-right">Amount</th><th>Source</th></tr></thead><tbody>{invoices.map(entry => <tr key={entry.id}><td className="reference">{entry.externalId}</td><td>{entry.reference}</td><td className="amount align-right">{money(entry.amountMinor)}</td><td><button className="source-link" onClick={() => void inspectSource(entry)}>View row <span aria-hidden="true">↗</span></button></td></tr>)}</tbody></table></div> : <p className="inline-empty">No open invoices.</p>}</section>
          <section className="panel"><div className="section-heading"><h2>Approved matches <span className="count">{data.resolutions.length}</span></h2><button className="text-button" onClick={() => setView('audit')}>View audit history <span aria-hidden="true">→</span></button></div>{data.resolutions.length ? <div >{data.resolutions.map(resolution => { const invoice = data.entries.find(entry => entry.id === resolution.invoiceId); const payment = data.entries.find(entry => entry.id === resolution.paymentId); return <article key={resolution.id} className="approved-row"><span className="approved-check" aria-hidden="true">✓</span><div><strong>{payment?.externalId ?? resolution.paymentId} <span className="quiet-text">→</span> {invoice?.externalId ?? resolution.invoiceId}</strong><p>{resolution.method === 'exact' ? 'Exact reference and amount' : 'Reference override'} · {resolution.actorId} · {when(resolution.createdAt)}</p>{resolution.note && <p className="review-note">“{resolution.note}”</p>}</div><strong className="amount">{money(resolution.amountMinor)}</strong></article>; })}</div> : <p className="inline-empty">No approved matches.</p>}</section>
        </>}
        {view === 'imports' && <div className="imports-layout"><section className="panel import-panel"><div className="section-heading"><h2>Import a CSV</h2><span className="pill slate">256 KiB / 500 rows</span></div><div className="sample-actions"><p>Sample files</p><div><button className="secondary" disabled={Boolean(busy) || !canWrite} onClick={() => void loadSample('invoice')}>Load invoices</button><button className="secondary" disabled={Boolean(busy) || !canWrite} onClick={() => void loadSample('payment')}>Load payments</button></div></div><form onSubmit={importCsv}><label htmlFor="kind">Source type</label><select id="kind" value={kind} onChange={event => setKind(event.target.value as Kind)} disabled={!canWrite || Boolean(busy)}><option value="invoice">Invoices</option><option value="payment">Payments</option></select><label htmlFor="csv-file">CSV file</label><input ref={fileInput} id="csv-file" type="file" accept=".csv,text/csv" disabled={!canWrite || Boolean(busy)} onChange={event => { const file = event.target.files?.[0]; if (!file) return; void perform('Reading file', async () => { if (file.size > 256 * 1024) throw new Error('Choose a CSV no larger than 256 KiB.'); const content = decodeCsv(await file.arrayBuffer()); setCsv(content); setFilename(file.name); setKey(crypto.randomUUID()); }); }} /><p className="field-help">{filename ? `Selected: ${filename}` : 'Choose a synthetic CSV or load a sample above.'}</p><label htmlFor="delivery-key">Delivery key</label><div className="key-field"><input id="delivery-key" value={key} maxLength={100} required disabled={!canWrite || Boolean(busy)} onChange={event => setKey(event.target.value)} /><button type="button" className="quiet" disabled={!canWrite || Boolean(busy)} onClick={() => setKey(crypto.randomUUID())}>New key</button></div><p className="field-help">Reuse this key when retrying this file. Different content with the same key is rejected.</p><label htmlFor="csv-preview">Original CSV preview</label><textarea className="csv-preview" id="csv-preview" value={csv} readOnly rows={8} placeholder={`${kind}_id,reference,amount,currency`} /><p className="field-help">EUR amounts use a decimal point and up to two decimal places. Review the row report after import.</p><button className="primary import-button" disabled={!canWrite || Boolean(busy) || !csv || !key.trim()}>{busy === 'Importing CSV' ? 'Importing…' : 'Import and validate'} <span aria-hidden="true">→</span></button></form></section><section className="panel"><div className="section-heading"><h2>Import history <span className="count">{data.imports.length}</span></h2></div>{data.imports.length ? data.imports.map(batch => <article key={batch.id} className="batch-card"><div><span className="eyebrow">{batch.kind === 'invoice' ? 'Invoices' : 'Payments'}</span><h3>{batch.filename}</h3><p>{when(batch.createdAt)}</p></div><div className="batch-counts"><span><strong>{batch.counts.accepted}</strong> accepted</span><span><strong>{batch.counts.duplicate}</strong> duplicate</span><span className={batch.counts.rejected + batch.counts.conflict ? 'amber-text' : ''}><strong>{batch.counts.rejected + batch.counts.conflict}</strong> exceptions</span></div><button className="secondary" disabled={Boolean(busy)} onClick={() => void inspectImport(batch.id)}>Inspect source & rows <span aria-hidden="true">↗</span></button></article>) : <div className="empty-state compact"><h3>No imports yet</h3><p>Load a sample or choose a CSV.</p></div>}<div className="import-guide"><h3>What happens to each row</h3><p><span className="status-dot teal-dot" /> <strong>Accepted:</strong> a validated entry is available for review.</p><p><span className="status-dot slate-dot" /> <strong>Duplicate:</strong> the same source ID and values already exist.</p><p><span className="status-dot amber-dot" /> <strong>Exception:</strong> malformed fields or conflicting values are retained for inspection and excluded from matching.</p></div></section></div>}
        {view === 'audit' && <section className="panel"><div className="section-heading"><h2>Audit record <span className="count">{data.audit.length}</span></h2><p>Most recent first</p></div>{data.audit.length ? <ol className="audit-list">{data.audit.map(event => <li key={event.id}><span className={`audit-symbol ${event.action === 'resolution_approved' ? 'approved' : ''}`} aria-hidden="true">{event.action === 'resolution_approved' ? '✓' : '↓'}</span><div><div className="audit-title"><h3>{event.action === 'resolution_approved' ? 'Match approved' : 'Import committed'}</h3><time dateTime={event.createdAt}>{when(event.createdAt)}</time></div><p className="audit-actor">By {event.actorId}</p><details><summary>Event details</summary><dl className="audit-details">{Object.entries(event.details).map(([name, value]) => <div key={name}><dt>{name.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl><p className="event-id">Event {event.id}</p></details></div></li>)}</ol> : <div className="empty-state compact"><h3>No audit events</h3><p>Import a CSV to get started.</p><button className="secondary" onClick={() => setView('imports')}>Go to imports</button></div>}</section>}
      </main>
    </>}
    <dialog ref={dialog} className="source-dialog" aria-labelledby="source-title" onClose={() => { setDetail(null); setSourceId(''); }}>
      {detail && <><div className="dialog-heading"><div><p className="eyebrow">Preserved source / {detail.kind}</p><h2 id="source-title">{detail.filename}</h2></div><button className="close-dialog" aria-label="Close source inspector" onClick={() => dialog.current?.close()}>×</button></div><div className="dialog-body"><div className="source-meta"><span>{when(detail.createdAt)}</span><button className="secondary" onClick={downloadSource}>Download original CSV <span aria-hidden="true">↓</span></button></div><div className="source-summary"><span className="pill teal">{detail.counts.accepted} accepted</span><span className="pill slate">{detail.counts.duplicate} duplicate</span><span className="pill amber">{detail.counts.rejected} rejected</span><span className="pill amber">{detail.counts.conflict} conflict</span></div><p className="source-key"><strong>Delivery key</strong> <code>{detail.idempotencyKey}</code></p><div className="source-rows">{detail.rows.map(row => <details key={row.id} id={`source-${row.id}`} className={`source-row ${row.id === sourceId ? 'highlighted' : ''}`} open={row.id === sourceId || undefined}><summary><span>Row {row.rowNumber}</span><span className="reference">{row.normalized.externalId || 'No source ID'}</span><span className={`pill ${row.disposition === 'accepted' ? 'teal' : row.disposition === 'duplicate' ? 'slate' : 'amber'}`}>{row.disposition}</span></summary>{row.errors.length > 0 && <ul className="row-errors">{row.errors.map((error, i) => <li key={i}>{error}</li>)}</ul>}<div className="source-columns"><div><h3>Original fields</h3><dl>{Object.entries(row.original).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value || <em>Empty</em>}</dd></div>)}</dl></div><div><h3>Normalized fields</h3><dl><div><dt>Source ID</dt><dd>{row.normalized.externalId || '—'}</dd></div><div><dt>Reference</dt><dd>{row.normalized.reference || '—'}</dd></div><div><dt>Amount</dt><dd>{row.normalized.amountMinor === null ? 'Invalid amount' : money(row.normalized.amountMinor)}</dd></div><div><dt>Currency</dt><dd>{row.normalized.currency || '—'}</dd></div></dl></div></div></details>)}</div></div></>}
    </dialog>
  </>;
}
