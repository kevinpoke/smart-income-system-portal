"use client";

// ISP support controls + special bridges batch: Support Chat clickable
// URL auto-linking (spec "SUPPORT CHAT — CLICKABLE LINKS"). Shared by
// BOTH the customer Support page and the admin Support Chats inbox so
// there is exactly one linkification implementation and the two views
// can never render a message differently.
//
// SECURITY:
// - Never uses dangerouslySetInnerHTML -- this renders an array of React
//   text nodes and <a> elements built by React itself, so all text
//   content stays safely escaped exactly like the plain string
//   interpolation this replaces (`{m.body}` inside a
//   whitespace-pre-wrap div).
// - Only auto-links http:// and https:// URLs. javascript:, data:,
//   file:, and any other scheme are matched by the same regex (a URL is
//   a URL) but are deliberately NOT rendered as an anchor -- they render
//   as plain escaped text, exactly like a message with no URL at all.
// - Every generated <a> carries target="_blank" rel="noopener
//   noreferrer" (safe external-link attributes).
// - Trailing sentence punctuation immediately after a URL (. , ! ? ; :
//   ) ] } as well as a closing quote) is excluded from the link so
//   "https://example.com." links to https://example.com, not
//   https://example.com. with a literal trailing period baked in.
//
// FORMATTING: this must be used INSIDE the exact same
// `whitespace-pre-wrap break-words` container the plain-text rendering
// already uses -- it only replaces the TEXT CONTENT of that container,
// never the container itself, so newlines/blank-line spacing is
// completely unaffected (newlines are just ordinary characters within
// the returned text/anchor node list, and the parent's CSS
// white-space: pre-wrap is what turns them into visible line breaks,
// exactly as it already does for the surrounding plain text).

// Matches a run of http(s):// followed by non-whitespace characters.
// Trailing punctuation is stripped by trimTrailingPunctuation() below
// rather than being excluded from the character class itself, since a
// URL can legitimately end in ')' etc. when balanced (e.g. Wikipedia
// URLs) -- stripping only unbalanced/sentence-final punctuation avoids
// breaking those.
const URL_REGEX = /https?:\/\/[^\s]+/g;

const TRAILING_PUNCTUATION_RE = /[),.!?;:'"\]}]+$/;

// Strips trailing sentence punctuation from a matched URL, but never
// strips a closing bracket/paren that has a matching opening one earlier
// in the SAME matched string (so a URL that legitimately ends in ")" is
// left intact when it is balanced).
function trimTrailingPunctuation(url) {
  let trimmed = url;
  while (true) {
    const match = trimmed.match(TRAILING_PUNCTUATION_RE);
    if (!match) break;
    const char = match[0][match[0].length - 1];
    if (char === ")" && countChar(trimmed, "(") >= countChar(trimmed, ")")) break;
    if (char === "]" && countChar(trimmed, "[") >= countChar(trimmed, "]")) break;
    if (char === "}" && countChar(trimmed, "{") >= countChar(trimmed, "}")) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function countChar(str, ch) {
  let count = 0;
  for (const c of str) if (c === ch) count += 1;
  return count;
}

// Only http:// and https:// are ever treated as clickable -- this is a
// belt-and-suspenders re-check alongside URL_REGEX already only matching
// those two schemes, so a future regex change can never silently start
// linking an unsafe scheme without this guard also being updated.
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Renders `text` as an array of plain strings and <a> elements: any
// substring matching a safe http(s) URL becomes a clickable link
// (target="_blank" rel="noopener noreferrer"); everything else is
// returned as an ordinary (safely-escaped-by-React) text node. Returns
// `text` completely unchanged (as a single plain string) when it
// contains no URL at all, so plain messages render identically to
// before this feature existed.
export function linkifyText(text) {
  if (!text) return text;
  URL_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(URL_REGEX)];
  if (matches.length === 0) return text;

  const nodes = [];
  let cursor = 0;
  matches.forEach((match, idx) => {
    const rawUrl = match[0];
    const start = match.index;
    const trimmedUrl = trimTrailingPunctuation(rawUrl);
    const trailingPunctuation = rawUrl.slice(trimmedUrl.length);
    const end = start + trimmedUrl.length;

    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }

    if (isSafeUrl(trimmedUrl)) {
      nodes.push(
        <a
          key={`link-${idx}-${start}`}
          href={trimmedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-current/50 underline-offset-2 hover:opacity-80"
        >
          {trimmedUrl}
        </a>
      );
    } else {
      // Not a safe scheme after all (shouldn't normally happen since
      // URL_REGEX only matches http/https literally) -- render as plain
      // text rather than a link.
      nodes.push(trimmedUrl);
    }

    cursor = end;
    if (trailingPunctuation) {
      nodes.push(trailingPunctuation);
    }
  });

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

// Convenience component wrapper -- renders linkifyText(text) as React
// children. Callers keep their own existing
// `whitespace-pre-wrap break-words` container div exactly as before;
// this only replaces `{m.body}` with `<LinkifiedText text={m.body} />`.
export default function LinkifiedText({ text }) {
  return <>{linkifyText(text)}</>;
}
