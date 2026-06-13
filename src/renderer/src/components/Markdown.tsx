import { Fragment, type CSSProperties, type ReactElement, type ReactNode } from 'react';

/**
 * A tiny, dependency-free Markdown renderer for native-agent prose. The transcript used
 * to render assistant text as one run-on `<span>`; this gives it the structure a reader
 * expects — fenced code blocks, inline `code`, bold and italic, headings, and bullet or
 * numbered lists — styled to the app's tokens so it reads like Claude Code / Cursor.
 *
 * Deliberately small: it covers the constructs agents actually emit, not the full
 * CommonMark grammar (no tables/blockquotes/nested lists/images). Unknown syntax falls
 * through as plain text, so nothing is ever lost — at worst a rare construct shows raw.
 * Links render as underlined, non-clickable text (the desktop shell has no openExternal
 * seam here) with the URL in a title tooltip.
 */

const mono = 'var(--cth-font-mono, monospace)';

/** Inline tokens: inline code, bold, italic (asterisk or underscore), and [text](url)
 *  links. Non-nested — first match wins, inner text emitted verbatim (fine for prose). */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={key} style={inlineCodeStyle}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('_')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      // [text](url)
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (lm) out.push(<span key={key} title={lm[2]} style={{ color: 'var(--cth-sky)', textDecoration: 'underline' }}>{lm[1]}</span>);
      else out.push(tok);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const inlineCodeStyle: CSSProperties = {
  fontFamily: mono,
  fontSize: '0.92em',
  background: 'var(--cth-paper-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  padding: '0 4px',
  borderRadius: 2
};

const HEADING = /^(#{1,6})\s+(.*)$/;
const ULI = /^\s*[-*+]\s+(.*)$/;
const OLI = /^\s*\d+[.)]\s+(.*)$/;

/** Parse the text into blocks and render them. Fenced code is extracted first so its
 *  contents are never treated as markdown. */
export function Markdown({ text }: { text: string }): ReactElement {
  const blocks: ReactNode[] = [];
  const lines = (text ?? '').split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ``` ... ```
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // consume the closing fence (if any)
      blocks.push(
        <pre key={`b${key++}`} style={codeBlockStyle}>
          <code style={{ fontFamily: mono }}>{body.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Blank line — skip (block separator).
    if (line.trim() === '') { i++; continue; }

    // Heading
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div key={`b${key++}`} style={{ fontWeight: 700, fontSize: level <= 2 ? '1.05em' : '1em', margin: '4px 0 2px' }}>
          {renderInline(h[2], `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    // Unordered / ordered list — consume consecutive items.
    if (ULI.test(line) || OLI.test(line)) {
      const ordered = OLI.test(line) && !ULI.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && (ULI.test(lines[i]) || OLI.test(lines[i]))) {
        const im = (ULI.exec(lines[i]) ?? OLI.exec(lines[i]))!;
        items.push(<li key={`li${i}`} style={{ margin: '1px 0' }}>{renderInline(im[1], `li${i}`)}</li>);
        i++;
      }
      const listStyle: CSSProperties = { margin: '2px 0', paddingLeft: 20 };
      blocks.push(ordered
        ? <ol key={`b${key++}`} style={listStyle}>{items}</ol>
        : <ul key={`b${key++}`} style={listStyle}>{items}</ul>);
      continue;
    }

    // Paragraph — consume consecutive plain lines, preserving their line breaks.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !HEADING.test(lines[i]) && !ULI.test(lines[i]) && !OLI.test(lines[i]) && !/^\s*```/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push(
      <div key={`b${key++}`} style={{ whiteSpace: 'pre-wrap', margin: '2px 0' }}>
        {para.map((l, li) => (
          <Fragment key={li}>{li > 0 ? '\n' : null}{renderInline(l, `p${key}-${li}`)}</Fragment>
        ))}
      </div>
    );
  }

  return <div style={{ display: 'flex', flexDirection: 'column' }}>{blocks}</div>;
}

const codeBlockStyle: CSSProperties = {
  fontFamily: mono,
  fontSize: '0.9em',
  background: 'var(--cth-paper-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  padding: '6px 8px',
  margin: '3px 0',
  overflowX: 'auto',
  whiteSpace: 'pre'
};
