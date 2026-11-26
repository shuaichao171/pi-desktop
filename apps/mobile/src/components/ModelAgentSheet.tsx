import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { UiAgentStatus, UiModelSummary, UiThinkingLevel } from '@pidesktop/shared';
import { useTheme } from '../theme';

interface ModelAgentSheetProps {
  visible: boolean;
  onClose: () => void;
  currentAgentId: string;
  currentProvider: string;
  currentModelId: string;
  currentThinking: UiThinkingLevel;
  availableThinking: readonly UiThinkingLevel[];
  models: readonly UiModelSummary[];
  agents: readonly UiAgentStatus[];
  onSelectAgent: (agentId: string) => Promise<void>;
  onSelectModel: (provider: string, id: string) => Promise<void>;
  onSelectThinking: (level: UiThinkingLevel) => Promise<void>;
}

export function ModelAgentSheet(props: ModelAgentSheetProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.models
      .filter((m) => !q || `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q))
      .slice(0, 60);
  }, [props.models, query]);

  return (
    <Modal visible={props.visible} animationType="slide" transparent onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <Text style={[styles.title, { color: theme.text }]}>Agent, Model & Thinking</Text>
            <Pressable onPress={props.onClose}>
              <Text style={{ color: theme.brand, fontWeight: '600', fontSize: 15 }}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={{ gap: 18, paddingBottom: 24 }}>
            <View style={{ gap: 8 }}>
              <Text style={[styles.section, { color: theme.textSubtle }]}>Agent Runtime</Text>
              <View style={styles.chipWrap}>
                <Pressable
                  onPress={() => void props.onSelectAgent('pi').then(props.onClose)}
                  style={[
                    styles.chip,
                    {
                      borderColor: props.currentAgentId === 'pi' ? theme.brand : theme.border,
                      backgroundColor: props.currentAgentId === 'pi' ? theme.brand : theme.surfaceAlt,
                    },
                  ]}
                >
                  <Text style={{ color: props.currentAgentId === 'pi' ? theme.brandInk : theme.text, fontWeight: '600' }}>
                    Pi (Built-in)
                  </Text>
                </Pressable>
                {props.agents
                  .filter((a) => a.enabled && a.readiness === 'ready')
                  .map((agent) => {
                    const selected = props.currentAgentId === agent.id;
                    return (
                      <Pressable
                        key={agent.id}
                        onPress={() => void props.onSelectAgent(agent.id).then(props.onClose)}
                        style={[
                          styles.chip,
                          {
                            borderColor: selected ? theme.brand : theme.border,
                            backgroundColor: selected ? theme.brand : theme.surfaceAlt,
                          },
                        ]}
                      >
                        <Text style={{ color: selected ? theme.brandInk : theme.text, fontWeight: '600' }}>
                          {agent.displayName}
                        </Text>
                      </Pressable>
                    );
                  })}
              </View>
            </View>

            {props.availableThinking.length > 0 && (
              <View style={{ gap: 8 }}>
                <Text style={[styles.section, { color: theme.textSubtle }]}>Thinking Level</Text>
                <View style={styles.chipWrap}>
                  {props.availableThinking.map((level) => {
                    const selected = level === props.currentThinking;
                    return (
                      <Pressable
                        key={level}
                        onPress={() => void props.onSelectThinking(level)}
                        style={[
                          styles.chip,
                          {
                            borderColor: selected ? theme.brand : theme.border,
                            backgroundColor: selected ? theme.brand : theme.surfaceAlt,
                          },
                        ]}
                      >
                        <Text style={{ color: selected ? theme.brandInk : theme.text, fontSize: 13 }}>
                          {level}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            <View style={{ gap: 8 }}>
              <Text style={[styles.section, { color: theme.textSubtle }]}>Model</Text>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Filter models…"
                placeholderTextColor={theme.textMuted}
                style={[styles.search, { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text }]}
              />
              {filteredModels.map((model) => {
                const selected = model.provider === props.currentProvider && model.id === props.currentModelId;
                return (
                  <Pressable
                    key={`${model.provider}/${model.id}`}
                    onPress={() => void props.onSelectModel(model.provider, model.id).then(props.onClose)}
                    style={[
                      styles.modelRow,
                      {
                        borderColor: selected ? theme.brand : theme.border,
                        backgroundColor: selected ? theme.surfaceAlt : 'transparent',
                      },
                    ]}
                  >
                    <Text style={{ color: theme.text, fontWeight: selected ? '700' : '500', fontSize: 14 }}>
                      {model.name || model.id}
                    </Text>
                    <Text style={{ color: theme.textMuted, fontSize: 12 }}>
                      {model.provider} · {model.id}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { height: '78%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingTop: 14 },
  section: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, borderWidth: 1 },
  search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  modelRow: { padding: 11, borderRadius: 9, borderWidth: 1, gap: 2 },
});
