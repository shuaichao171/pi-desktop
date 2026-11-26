import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { UiExtensionDialogRequest, UiExtensionDialogResponse } from '@pidesktop/shared';
import { useTheme } from '../theme';

interface ApprovalCardProps {
  request: UiExtensionDialogRequest;
  canOperate: boolean;
  onRespond: (id: string, value: UiExtensionDialogResponse) => Promise<void>;
}

export function ApprovalCard({ request, canOperate, onRespond }: ApprovalCardProps) {
  const theme = useTheme();
  const [textValue, setTextValue] = useState(request.defaultValue ?? '');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (value: UiExtensionDialogResponse) => {
    if (!canOperate || submitting) return;
    setSubmitting(true);
    try {
      await onRespond(request.id, value);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.warning }]}>
      <View style={styles.header}>
        <Text style={[styles.badge, { backgroundColor: theme.warning, color: '#111' }]}>
          {request.approval ? 'APPROVAL REQUIRED' : 'ACTION NEEDED'}
        </Text>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
          {request.title}
        </Text>
      </View>

      {Boolean(request.message || request.approval?.command) && (
        <ScrollView style={styles.bodyScroll} nestedScrollEnabled>
          {request.approval?.command ? (
            <Text style={[styles.code, { backgroundColor: theme.surfaceAlt, color: theme.text }]}>
              {request.approval.command}
            </Text>
          ) : null}
          {request.message ? (
            <Text style={[styles.message, { color: theme.textSubtle }]}>{request.message}</Text>
          ) : null}
        </ScrollView>
      )}

      {!canOperate ? (
        <Text style={[styles.readonlyHint, { color: theme.textMuted }]}>
          Read-only session: approve or respond from the desktop or a full-control device.
        </Text>
      ) : request.kind === 'confirm' && request.approval?.agentOptions?.length ? (
        <View style={styles.optionList}>
          {request.approval.agentOptions.map((option, idx) => {
            const isAllow = option.kind === 'allow_once' || option.kind === 'allow_always' || idx === 0;
            return (
              <Pressable
                key={option.id}
                disabled={submitting}
                onPress={() => void submit({ optionId: option.id })}
                style={[
                  styles.optionBtn,
                  {
                    borderColor: isAllow ? theme.brand : theme.border,
                    backgroundColor: isAllow ? theme.brand : theme.surfaceAlt,
                  },
                ]}
              >
                <Text style={{ color: isAllow ? theme.brandInk : theme.text, fontWeight: '600' }}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : request.kind === 'confirm' ? (
        <View style={styles.btnRow}>
          <Pressable
            disabled={submitting}
            onPress={() => void submit(false)}
            style={[styles.btn, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
          >
            <Text style={{ color: theme.text, fontWeight: '600' }}>Deny</Text>
          </Pressable>
          <Pressable
            disabled={submitting}
            onPress={() => void submit(true)}
            style={[styles.btn, { borderColor: theme.brand, backgroundColor: theme.brand }]}
          >
            <Text style={{ color: theme.brandInk, fontWeight: '600' }}>Approve</Text>
          </Pressable>
        </View>
      ) : request.kind === 'select' && request.options?.length ? (
        <View style={styles.optionList}>
          {request.options.map((option, idx) => (
            <Pressable
              key={`${option}-${idx}`}
              disabled={submitting}
              onPress={() => void submit(option)}
              style={[
                styles.optionBtn,
                {
                  borderColor: idx === 0 ? theme.brand : theme.border,
                  backgroundColor: idx === 0 ? theme.brand : theme.surfaceAlt,
                },
              ]}
            >
              <Text style={{ color: idx === 0 ? theme.brandInk : theme.text, fontWeight: '600' }}>
                {option}
              </Text>
            </Pressable>
          ))}
          <Pressable
            disabled={submitting}
            onPress={() => void submit(null)}
            style={[styles.optionBtn, { borderColor: theme.border, backgroundColor: 'transparent' }]}
          >
            <Text style={{ color: theme.textSubtle }}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.inputGroup}>
          <TextInput
            value={textValue}
            onChangeText={setTextValue}
            placeholder={request.placeholder ?? 'Type response…'}
            placeholderTextColor={theme.textMuted}
            multiline={request.kind === 'editor'}
            style={[
              styles.input,
              { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text },
              request.kind === 'editor' ? { minHeight: 72, textAlignVertical: 'top' } : null,
            ]}
          />
          <View style={styles.btnRow}>
            <Pressable
              disabled={submitting}
              onPress={() => void submit(null)}
              style={[styles.btn, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
            >
              <Text style={{ color: theme.textSubtle }}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={submitting}
              onPress={() => void submit(textValue)}
              style={[styles.btn, { borderColor: theme.brand, backgroundColor: theme.brand }]}
            >
              <Text style={{ color: theme.brandInk, fontWeight: '600' }}>Submit</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    gap: 10,
  },
  header: { gap: 6 },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    overflow: 'hidden',
  },
  title: { fontSize: 15, fontWeight: '600' },
  bodyScroll: { maxHeight: 120 },
  code: { fontFamily: 'monospace', fontSize: 12, padding: 8, borderRadius: 6, marginBottom: 6 },
  message: { fontSize: 13, lineHeight: 19 },
  readonlyHint: { fontSize: 12, fontStyle: 'italic' },
  btnRow: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  optionList: { gap: 8 },
  optionBtn: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  inputGroup: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
});
