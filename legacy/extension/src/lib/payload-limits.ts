export const MAX_DDL_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_SQL_PAYLOAD_CHARS = 1_500_000;

export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertUtf8ByteLimit(value: string, maxBytes: number, label: string): void {
  const size = getUtf8ByteLength(value);
  if (size > maxBytes) {
    throw new Error(`${label} exceeds the ${formatMegabytes(maxBytes)} MB limit.`);
  }
}

export function assertSqlPayload(sql: string, cursor?: number): void {
  if (typeof sql !== "string" || sql.length > MAX_SQL_PAYLOAD_CHARS) {
    throw new Error(`SQL exceeds the ${MAX_SQL_PAYLOAD_CHARS.toLocaleString()} character limit.`);
  }
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > sql.length)) {
    throw new Error("SQL cursor is outside the document range.");
  }
}

function formatMegabytes(bytes: number): string {
  return String(bytes / 1024 / 1024);
}