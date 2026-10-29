/**
 * Parser de Markdown ligero (sin dependencias) para las respuestas de los agentes.
 * Soporta: bloques de código ```, títulos #, listas (-, *, 1.), citas >, tablas |,
 * separadores ---, **negrita**, *cursiva*, `código` y [enlaces](url).
 * Nunca lanza: ante cualquier cosa rara devuelve párrafos de texto.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

export type Block =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; level: number; inl: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; inl: Inline[] }
  | { t: 'hr' }
  | { t: 'table'; header: boolean; rows: Inline[][][] };

const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s](?:[^*]*?[^*\s])?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'bold', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'bold', v: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'italic', v: m[5] });
    else if (m[6] !== undefined) out.push({ t: 'link', v: m[6], href: m[7] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?)?\s*\|?\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UL = /^\s*[-*+•]\s+(.*)$/;
const OL = /^\s*(\d{1,4})[.)]\s+(.*)$/;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || TABLE.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  try {
    const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out: Block[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(FENCE);
      if (fence) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !FENCE_END.test(lines[i])) buf.push(lines[i++]);
        i++; // cierre (o fin del texto si no se cerró)
        out.push({ t: 'code', lang: fence[1] || '', v: buf.join('\n') });
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const h = line.match(HEADING);
      if (h) {
        out.push({ t: 'h', level: h[1].length, inl: parseInline(h[2]) });
        i++;
        continue;
      }
      if (HR.test(line)) {
        out.push({ t: 'hr' });
        i++;
        continue;
      }
      if (TABLE.test(line)) {
        const rows: Inline[][][] = [];
        let header = false;
        while (i < lines.length && (TABLE.test(lines[i]) || TABLE_SEP.test(lines[i]))) {
          if (TABLE_SEP.test(lines[i])) {
            if (rows.length === 1) header = true;
          } else {
            rows.push(splitRow(lines[i]).map(parseInline));
          }
          i++;
        }
        out.push({ t: 'table', header, rows });
        continue;
      }
      if (QUOTE.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && QUOTE.test(lines[i])) buf.push((lines[i++].match(QUOTE) as RegExpMatchArray)[1]);
        out.push({ t: 'quote', inl: parseInline(buf.join('\n')) });
        continue;
      }
      const ul = line.match(UL);
      const ol = line.match(OL);
      if (ul || ol) {
        const ordered = !ul;
        const items: string[] = [];
        const start = ol ? Number(ol[1]) : 1;
        while (i < lines.length) {
          const l = lines[i];
          const mu = l.match(UL);
          const mo = l.match(OL);
          if ((ordered && mo) || (!ordered && mu)) {
            items.push((ordered ? (mo as RegExpMatchArray)[2] : (mu as RegExpMatchArray)[1]).trim());
            i++;
          } else if (l.trim() && /^\s{2,}\S/.test(l) && !startsBlock(l.trimStart()) && items.length) {
            items[items.length - 1] += ' ' + l.trim(); // continuación de la línea anterior
            i++;
          } else if (l.trim() && /^\s{2,}/.test(l) && (UL.test(l) || OL.test(l))) {
            // sublista: se aplana como elementos normales
            const sub = (l.match(UL) || l.match(OL)) as RegExpMatchArray;
            items.push((sub[2] ?? sub[1]).trim());
            i++;
          } else break;
        }
        const parsed = items.map(parseInline);
        out.push(ordered ? { t: 'ol', start, items: parsed } : { t: 'ul', items: parsed });
        continue;
      }
      const buf: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++]);
      out.push({ t: 'p', inl: parseInline(buf.join('\n')) });
    }
    return out;
  } catch {
    return [{ t: 'p', inl: [{ t: 'text', v: String(src ?? '') }] }];
  }
}
