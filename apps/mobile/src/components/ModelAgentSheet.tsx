import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  PI_AGENT_ID,
  agentCapabilities,
  type UiAgentDescriptor,
  type UiAgentStatus,
  type UiModelSummary,
  type UiThinkingLevel,
} from '@pidesktop/shared';
import { font, radius, space, useTheme } from '../theme';
import { t, thinkingLabel } from '../i18n';
import { Banner, Chip, SectionLabel, TextAction, TextField } from './ui';

interface ModelAgentSheetProps {
  visible: boolean;
  onClose: () => void;
  agent?: UiAgentDescriptor | null;
  agentLocked: boolean;
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
  onSelectAgentOption: (optionId: string, value: string) => Promise<void>;
}

function ModelRow({
  title,
  detail,
  selected,
  disabled,
  onPress,
}: {
  title: string;
  detail: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modelRow,
        { backgroundColor: pressed ? theme.surface : selected ? theme.brandSoft : 'transparent', opacity: disabled && !selected ? 0.6 : 1 },
      ]}
    >
      <View style={styles.modelCopy}>
        <Text style={{ color: theme.text, fontSize: font.body, fontWeight: selected ? '600' : '400' }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: font.caption }} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {selected ? <Text style={[styles.check, { color: theme.brand }]}>✓</Text> : null}
    </Pressable>
  );
}

export function ModelAgentSheet(props: ModelAgentSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (props.visible) {
      setError(null);
      setQuery('');
    }
  }, [props.visible]);

  const isAcp = props.agent?.kind === 'acp';
  const caps = agentCapabilities(props.agent);
  const showThinkingLevels = caps.thinkingLevels && props.availableThinking.length > 1;
  const acpModels = props.agent?.models ?? [];
  const acpOptions = props.agent?.options ?? [];
  const activeAcpModelId = props.agent?.currentModelId || props.currentModelId;
  const readyAgents = props.agents.filter((a) => a.enabled && a.readiness === 'ready');

  const filteredPiModels = useMemo(() => {
    if (isAcp) return [];
    const q = query.trim().toLowerCase();
    const matches = props.models.filter((m) => !q || `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q));
    // Keep the current model first so its check mark is visible and never cut off by the limit.
    const current = matches.findIndex((m) => m.provider === props.currentProvider && m.id === props.currentModelId);
    if (current > 0) matches.unshift(...matches.splice(current, 1));
    return matches.slice(0, 60);
  }, [isAcp, props.models, props.currentProvider, props.currentModelId, query]);

  const filteredAcpModels = useMemo(() => {
    if (!isAcp) return [];
    const q = query.trim().toLowerCase();
    return acpModels.filter((m) => !q || `${m.id} ${m.name} ${m.description ?? ''}`.toLowerCase().includes(q));
  }, [isAcp, acpModels, query]);

  const runUpdate = async (work: () => Promise<void>, closeAfter = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      if (closeAfter) props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal visible={props.visible} animationType="slide" transparent onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} accessibilityLabel={t('common.close')} />
        <View style={[styles.sheet, { backgroundColor: theme.bg, paddingBottom: insets.bottom }]}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: theme.text }]}>{t('model.title')}</Text>
            <TextAction label={t('common.done')} onPress={props.onClose} />
          </View>

          {error ? <Banner tone="danger" text={error} actionLabel={t('common.dismiss')} onPress={() => setError(null)} /> : null}

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {readyAgents.length > 0 || props.currentAgentId !== PI_AGENT_ID ? (
              <>
                <SectionLabel>{t('model.agent')}</SectionLabel>
                {props.agentLocked ? <Text style={[styles.note, { color: theme.textMuted }]}>{t('model.agentLocked')}</Text> : null}
                <View style={styles.chipWrap}>
                  <Chip
                    label={t('model.builtin')}
                    selected={props.currentAgentId === PI_AGENT_ID}
                    disabled={busy || props.agentLocked || props.currentAgentId === PI_AGENT_ID}
                    onPress={() => void runUpdate(() => props.onSelectAgent(PI_AGENT_ID), true)}
                  />
                  {readyAgents.map((agent) => {
                    const selected = props.currentAgentId === agent.id;
                    return (
                      <Chip
                        key={agent.id}
                        label={agent.displayName}
                        selected={selected}
                        disabled={busy || props.agentLocked || selected}
                        onPress={() => void runUpdate(() => props.onSelectAgent(agent.id), true)}
                      />
                    );
                  })}
                </View>
              </>
            ) : null}

            {showThinkingLevels ? (
              <>
                <SectionLabel>{t('model.thinking')}</SectionLabel>
                <View style={styles.chipWrap}>
                  {props.availableThinking.map((level) => (
                    <Chip
                      key={level}
                      label={thinkingLabel(level)}
                      selected={level === props.currentThinking}
                      disabled={busy}
                      onPress={() => void runUpdate(() => props.onSelectThinking(level))}
                    />
                  ))}
                </View>
              </>
            ) : null}

            {isAcp
              ? acpOptions.map((option) => (
                  <View key={option.id}>
                    <SectionLabel>{option.name}</SectionLabel>
                    {option.description ? <Text style={[styles.note, { color: theme.textMuted }]}>{option.description}</Text> : null}
                    <View style={styles.chipWrap}>
                      {option.values.map((choice) => (
                        <Chip
                          key={choice.value}
                          label={choice.name}
                          selected={choice.value === option.currentValue}
                          disabled={busy}
                          onPress={() => void runUpdate(() => props.onSelectAgentOption(option.id, choice.value))}
                        />
                      ))}
                    </View>
                  </View>
                ))
              : null}

            <SectionLabel>{t('model.model')}</SectionLabel>
            {!isAcp || acpModels.length > 0 ? (
              <View style={styles.searchWrap}>
                <TextField value={query} onChangeText={setQuery} placeholder={t('model.search')} />
              </View>
            ) : null}

            {isAcp ? (
              acpModels.length === 0 ? (
                <Text style={[styles.note, { color: theme.textMuted }]}>
                  {t('model.noAgentModels', { name: props.agent?.displayName ?? 'Agent' })}
                </Text>
              ) : filteredAcpModels.length === 0 ? (
                <Text style={[styles.note, { color: theme.textMuted }]}>{t('model.noMatch')}</Text>
              ) : (
                filteredAcpModels.map((model) => (
                  <ModelRow
                    key={model.id}
                    title={model.name || model.id}
                    detail={model.description ? `${model.id} · ${model.description}` : model.id}
                    selected={model.id === activeAcpModelId}
                    disabled={busy}
                    onPress={() => void runUpdate(() => props.onSelectModel(`acp:${props.agent!.id}`, model.id), true)}
                  />
                ))
              )
            ) : filteredPiModels.length === 0 ? (
              <Text style={[styles.note, { color: theme.textMuted }]}>{t('model.noMatch')}</Text>
            ) : (
              filteredPiModels.map((model) => (
                <ModelRow
                  key={`${model.provider}/${model.id}`}
                  title={model.name || model.id}
                  detail={model.provider}
                  selected={model.provider === props.currentProvider && model.id === props.currentModelId}
                  disabled={busy}
                  onPress={() => void runUpdate(() => props.onSelectModel(model.provider, model.id), true)}
                />
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '82%', borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: space.sm },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  title: { fontSize: font.heading, fontWeight: '700' },
  content: { paddingBottom: space.lg },
  note: { fontSize: font.caption, lineHeight: 17, paddingHorizontal: space.lg, paddingBottom: space.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg },
  searchWrap: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 10,
    borderRadius: radius.md,
    gap: space.md,
  },
  modelCopy: { flex: 1, gap: 1 },
  check: { fontSize: font.heading, fontWeight: '700' },
});
