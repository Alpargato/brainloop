/** Renderiza en React Native el Markdown que devuelven los agentes. */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { THEME } from '../theme';
import { Block, Inline, parseMarkdown } from './markdownParser';

interface Props {
  text: string;
  accent?: string;
  fontSize?: number;
}

export default function Markdown({ text, accent = THEME.neonCyan, fontSize = 14 }: Props) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const lineHeight = Math.round(fontSize * 1.5);

  const inline = (items: Inline[], key: string) =>
    items.map((it, i) => {
      const k = `${key}-${i}`;
      switch (it.t) {
        case 'bold':
          return (
            <Text key={k} style={{ fontWeight: '700', color: THEME.text }}>
              {it.v}
            </Text>
          );
        case 'italic':
          return (
            <Text key={k} style={{ fontStyle: 'italic' }}>
              {it.v}
            </Text>
          );
        case 'code':
          return (
            <Text key={k} style={[styles.inlineCode, { fontSize: fontSize - 1 }]}>
              {it.v}
            </Text>
          );
        case 'link':
          return (
            <Text key={k}>
              <Text style={{ color: accent, textDecorationLine: 'underline' }}>{it.v}</Text>
              <Text style={{ color: THEME.textMuted }}> ({it.href})</Text>
            </Text>
          );
        default:
          return <Text key={k}>{it.v}</Text>;
      }
    });

  const base = { color: THEME.text, fontSize, lineHeight };

  const render = (b: Block, i: number) => {
    const key = `b${i}`;
    switch (b.t) {
      case 'h': {
        const size = b.level === 1 ? fontSize + 5 : b.level === 2 ? fontSize + 3 : fontSize + 1;
        return (
          <Text key={key} selectable style={[base, { fontSize: size, lineHeight: Math.round(size * 1.35), fontWeight: '800', marginTop: i ? 4 : 0 }]}>
            {inline(b.inl, key)}
          </Text>
        );
      }
      case 'code':
        return (
          <View key={key} style={styles.codeBox}>
            {!!b.lang && <Text style={[styles.codeLang, { color: accent }]}>{b.lang.toUpperCase()}</Text>}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable style={styles.codeText}>
                {b.v}
              </Text>
            </ScrollView>
          </View>
        );
      case 'ul':
      case 'ol':
        return (
          <View key={key} style={{ gap: 4 }}>
            {b.items.map((item, j) => (
              <View key={`${key}-${j}`} style={styles.listRow}>
                <Text style={[base, styles.bullet, { color: accent }]}>
                  {b.t === 'ol' ? `${b.start + j}.` : '•'}
                </Text>
                <Text selectable style={[base, styles.listText]}>
                  {inline(item, `${key}-${j}`)}
                </Text>
              </View>
            ))}
          </View>
        );
      case 'quote':
        return (
          <View key={key} style={[styles.quote, { borderLeftColor: accent }]}>
            <Text selectable style={[base, { color: THEME.textMuted }]}>
              {inline(b.inl, key)}
            </Text>
          </View>
        );
      case 'hr':
        return <View key={key} style={styles.hr} />;
      case 'table':
        return (
          <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
              {b.rows.map((row, r) => (
                <View key={`${key}-${r}`} style={[styles.tr, r === 0 && b.header && styles.th]}>
                  {row.map((cell, c) => (
                    <Text
                      key={`${key}-${r}-${c}`}
                      selectable
                      style={[base, styles.td, { fontSize: fontSize - 1 }, r === 0 && b.header && { fontWeight: '700' }]}
                    >
                      {inline(cell, `${key}-${r}-${c}`)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );
      default:
        return (
          <Text key={key} selectable style={base}>
            {inline(b.inl, key)}
          </Text>
        );
    }
  };

  return <View style={{ gap: 8 }}>{blocks.map(render)}</View>;
}

const styles = StyleSheet.create({
  inlineCode: {
    fontFamily: 'monospace',
    color: '#E2E8F0',
    backgroundColor: '#1A1E30',
  },
  codeBox: {
    backgroundColor: '#05060A',
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  codeLang: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  codeText: { fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19, color: '#E2E8F0' },
  listRow: { flexDirection: 'row', gap: 8, paddingRight: 4 },
  bullet: { minWidth: 16, fontWeight: '800' },
  listText: { flex: 1 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  hr: { height: 1, backgroundColor: THEME.border, marginVertical: 4 },
  table: { borderWidth: 1, borderColor: THEME.border, borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: THEME.border },
  th: { backgroundColor: '#161928' },
  td: { width: 130, paddingHorizontal: 8, paddingVertical: 6 },
});
