export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quoteQualifiedIdentifier(identifier: string): string {
  const parts = splitQualifiedIdentifier(identifier);
  if (parts.length === 0) return identifier;
  return parts.map((part) => (isQuotedIdentifier(part) ? part : quoteIdentifier(part))).join(".");
}

function isQuotedIdentifier(value: string): boolean {
  return /^"(?:[^"]|"")*"$/.test(value);
}

function splitQualifiedIdentifier(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '"') {
      if (inQuotes && value[index + 1] === '"') {
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (character === "." && !inQuotes) {
      const part = value.slice(start, index).trim();
      if (!part) return [];
      parts.push(part);
      start = index + 1;
    }
  }
  const finalPart = value.slice(start).trim();
  if (!finalPart || inQuotes) return [];
  parts.push(finalPart);
  return parts;
}