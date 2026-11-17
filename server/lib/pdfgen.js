const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

function esc(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7e]/g, '?');
}

function wrap(text, fontSize) {
  const maxChars = Math.floor((PAGE_W - MARGIN * 2) / (fontSize * 0.5));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const STYLES = {
  h1: { font: 'F2', size: 22, leading: 30, gapBefore: 0 },
  h2: { font: 'F2', size: 14, leading: 20, gapBefore: 10 },
  p: { font: 'F1', size: 11.5, leading: 17, gapBefore: 4 },
  small: { font: 'F1', size: 9.5, leading: 14, gapBefore: 2 },
};

/**
 * Build a real, multi-page PDF (A4, Helvetica) from structured blocks.
 * blocks: [{ type: 'h1'|'h2'|'p'|'small', text }]
 */
export function buildPdf({ blocks, title = 'STUDYFLIX', footer = 'STUDYFLIX — Learn. Explore. Grow.' }) {
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;

  const pushPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };

  for (const block of blocks) {
    const style = STYLES[block.type] || STYLES.p;
    const lines = wrap(block.text, style.size);
    for (const line of lines) {
      if (y < MARGIN + 30) pushPage();
      y -= style.gapBefore;
      y -= style.leading;
      ops.push(`BT /${style.font} ${style.size} Tf ${MARGIN} ${y.toFixed(2)} Td (${esc(line)}) Tj ET`);
    }
  }
  if (ops.length) pushPage();

  const pageCount = pages.length;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  const add = (id, body) => {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  };

  const pageIds = [];
  for (let i = 0; i < pageCount; i++) {
    const contentId = 5 + i * 2;
    const pageId = 6 + i * 2;
    pageIds.push(pageId);
    const footerText = `${footer}  ·  ${title}  ·  Page ${i + 1} of ${pageCount}`;
    const stream = [
      pages[i],
      `BT /F1 8.5 Tf ${MARGIN} ${MARGIN - 12} Td (${esc(footerText)}) Tj ET`,
    ].join('\n');
    add(contentId, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    add(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
  }

  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  add(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const maxId = 4 + pageCount * 2;
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    xref += `${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
