export type Kind = 'invoice' | 'payment';
export type Role = 'viewer' | 'reviewer';
export interface Actor { id: string; role: Role }
export interface Entry { id: string; kind: Kind; externalId: string; reference: string; amountMinor: string; currency: 'EUR'; sourceRowId: string; conflictSourceRowIds: string[] }
export interface SourceRow { id: string; rowNumber: number; original: Record<string, string>; normalized: { externalId: string; reference: string; amountMinor: string | null; currency: string }; errors: string[]; disposition: 'accepted' | 'duplicate' | 'rejected' | 'conflict'; entryId: string | null }
export interface ImportBatch { id: string; kind: Kind; filename: string; idempotencyKey: string; createdAt: string; counts: { accepted: number; duplicate: number; rejected: number; conflict: number } }
export interface ImportDetail extends ImportBatch { csv: string; rows: SourceRow[] }
export interface Resolution { id: string; invoiceId: string; paymentId: string; amountMinor: string; note: string; method: 'exact' | 'reference_override'; actorId: string; createdAt: string }
export interface AuditEvent { id: string; action: 'import_committed' | 'resolution_approved'; actorId: string; createdAt: string; details: Record<string, unknown> }
export interface Workbench { imports: ImportBatch[]; entries: Entry[]; resolutions: Resolution[]; audit: AuditEvent[] }
export interface ImportInput { kind: Kind; filename: string; csv: string; idempotencyKey: string }
export interface ApprovalInput { invoiceId: string; paymentId: string; note: string }
export interface ImportResult { batch: ImportBatch; replayed: boolean }
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
