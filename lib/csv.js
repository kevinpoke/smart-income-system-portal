// Shared, minimal CSV-escaping helper (spec: "CSV escaping must
// correctly handle: commas, quotes, newlines"). RFC 4180-style:
// - a field containing a comma, double-quote, or any newline
//   (\n or \r) is wrapped in double quotes
// - any double-quote inside the field is escaped by doubling it
// null/undefined become an empty field (never the literal string
// "null"/"undefined").
export function csvEscapeField(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Builds a full CSV document (with a trailing newline after every row,
// including the header) from a header array and an array of row arrays.
// Every cell is passed through csvEscapeField -- callers should NOT
// pre-escape values themselves.
export function buildCsv(headers, rows) {
  const lines = [headers.map(csvEscapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscapeField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
