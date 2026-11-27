import React, { memo, useMemo } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { font, radius, space, useTheme, type MobileTheme } from '../theme';
import { copyText } from './copy';

/**
 * A small Markdown renderer for assistant replies: paragraphs, headings, lists, quotes, rules, fenced code
 * and tables, plus inline code, bold, italic, strikethrough and links. Anything else stays plain text.
 */

type ListItem = { readonly indent: number; readonly marker: string; text: string };

export type MarkdownBlock =
  | { readonly kind: 'para'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'list'; readonly items: ListItem[] }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'rule' }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'table'; readonly rows: string[][] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
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
      const body: string[] = [];
      i += 1;
      // An unclosed fence (a reply still streaming) runs to the end of the text.
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
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
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
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

// 1 inline code · 2 bold · 3 strikethrough · 4/5 link text/url · 6 italic · 7 bare URL
const INLINE =
  /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)??)\*\*(?!\*)|~~([^~\n]+)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"，。；：！？、）】])/g;

function openLink(url: string) {
  void Linking.openURL(url).catch(() => {});
}

function renderInline(text: string, theme: MobileTheme): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, 'g');
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    // "a*b*c" or "2*3*4" is not emphasis.
    if (match[6] !== undefined && match.index > 0 && /[\w*]/.test(text[match.index - 1])) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > last) out.push(text.slice(last, match.index));
    key += 1;
    if (match[1] !== undefined) {
      out.push(
        <Text key={key} style={[styles.inlineCode, { backgroundColor: theme.surfaceAlt, color: theme.text }]}>
          {` ${match[1]} `}
        </Text>,
      );
    } else if (match[2] !== undefined) {
      out.push(
        <Text key={key} style={styles.bold}>
          {renderInline(match[2], theme)}
        </Text>,
      );
    } else if (match[3] !== undefined) {
      out.push(
        <Text key={key} style={styles.strike}>
          {renderInline(match[3], theme)}
        </Text>,
      );
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const url = match[5];
      out.push(
        <Text key={key} style={{ color: theme.brand }} onPress={() => openLink(url)}>
          {match[4]}
        </Text>,
      );
    } else if (match[6] !== undefined) {
      out.push(
        <Text key={key} style={styles.italic}>
          {renderInline(match[6], theme)}
        </Text>,
      );
    } else if (match[7] !== undefined) {
      const url = match[7];
      out.push(
        <Text key={key} style={{ color: theme.brand }} onPress={() => openLink(url)}>
          {url}
        </Text>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Wide characters take about two Latin widths; used to size table columns. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

function CodeBlock({ lang, text, theme }: { lang: string; text: string; theme: MobileTheme }) {
  return (
    <Pressable onLongPress={() => copyText(text)} style={[styles.codeBlock, { backgroundColor: theme.surface }]}>
      {lang ? <Text style={[styles.codeLang, { color: theme.textMuted }]}>{lang}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={[styles.code, { color: theme.text }]}>{text || ' '}</Text>
      </ScrollView>
    </Pressable>
  );
}

function Table({ rows, theme }: { rows: string[][]; theme: MobileTheme }) {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, col) => {
    const longest = Math.max(...rows.map((row) => displayWidth(row[col] ?? '')));
    return Math.min(220, Math.max(56, longest * 7.5 + 20));
  });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.table, { borderColor: theme.border }]}>
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[
              styles.tableRow,
              { borderColor: theme.border, backgroundColor: rowIndex === 0 ? theme.surface : 'transparent' },
              rowIndex === 0 ? null : styles.tableRowBorder,
            ]}
          >
            {widths.map((width, col) => (
              <Text
                key={col}
                style={[styles.tableCell, { width, color: theme.text, fontWeight: rowIndex === 0 ? '600' : '400' }]}
              >
                {renderInline(row[col] ?? '', theme)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const HEADING_SIZES = [19, 17, 16, 15, 15, 15];

function Block({ block, theme }: { block: MarkdownBlock; theme: MobileTheme }) {
  switch (block.kind) {
    case 'para':
      return <Text style={[styles.text, { color: theme.text }]}>{renderInline(block.text, theme)}</Text>;
    case 'heading':
      return (
        <Text style={[styles.heading, { color: theme.text, fontSize: HEADING_SIZES[block.level - 1] }]}>
          {renderInline(block.text, theme)}
        </Text>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => {
            const ordered = /\d/.test(item.marker);
            return (
              <View key={index} style={[styles.listItem, { paddingLeft: item.indent * 16 }]}>
                <Text style={[styles.text, ordered ? styles.orderedMarker : styles.bulletMarker, { color: theme.textSubtle }]}>
                  {ordered ? item.marker.replace(')', '.') : item.indent > 0 ? '◦' : '•'}
                </Text>
                <Text style={[styles.text, styles.listText, { color: theme.text }]}>{renderInline(item.text, theme)}</Text>
              </View>
            );
          })}
        </View>
      );
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: theme.border }]}>
          <Text style={[styles.text, { color: theme.textSubtle }]}>{renderInline(block.text, theme)}</Text>
        </View>
      );
    case 'rule':
      return <View style={[styles.rule, { backgroundColor: theme.border }]} />;
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} theme={theme} />;
    case 'table':
      return <Table rows={block.rows} theme={theme} />;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} theme={theme} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 10 },
  text: { fontSize: font.body, lineHeight: 23 },
  heading: { fontWeight: '700', lineHeight: 25, marginTop: 4 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: 'monospace', fontSize: font.small },
  list: { gap: 4 },
  listItem: { flexDirection: 'row' },
  bulletMarker: { width: 16 },
  orderedMarker: { minWidth: 22, paddingRight: 4 },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: space.md },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
  codeBlock: { borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, gap: 4 },
  codeLang: { fontSize: 11, fontWeight: '600' },
  code: { fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  tableRowBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  tableCell: { fontSize: font.small, lineHeight: 19, paddingHorizontal: space.sm, paddingVertical: 6 },
});
