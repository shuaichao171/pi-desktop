type ListItem = { readonly indent: number; readonly marker: string; text: string };

export type MarkdownBlock =
  | { readonly kind: 'para'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'list'; readonly items: ListItem[] }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'table'; readonly rows: string[][] };

const FENCE = /^ {0,3}(?:(`{3,})[ \t]*([^`\s]*)[^`]*|(~{3,})[ \t]*(\S*).*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] | null = null;

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'para', text: paragraph.join('\n') });
    paragraph = [];
    if (list) blocks.push({ kind: 'list', items: list });
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? fence[3];
      const lang = fence[2] ?? fence[4] ?? '';
      const body: string[] = [];
      i += 1;
      // An unclosed fence (a reply still streaming) runs to the end of the text.
      while (i < lines.length && !CLOSING_FENCE.exec(lines[i])?.[1].startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      flush();
      const rows = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim() });
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      if (paragraph.length > 0) flush();
      if (!list) list = [];
      list.push({ indent: Math.min(3, Math.floor(item[1].replace(/\t/g, '  ').length / 2)), marker: item[2], text: item[3] });
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      // An indented line under a list item continues that item.
      list[list.length - 1].text += `\n${line.trim()}`;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
        i += 1;
        body.push(QUOTE.exec(lines[i])![1]);
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}
