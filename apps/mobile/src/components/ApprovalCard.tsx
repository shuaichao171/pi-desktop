import React, { useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  requireElicitationResponse,
  type UiApprovalScope,
  type UiElicitationField,
  type UiElicitationForm,
  type UiElicitationValue,
  type UiExtensionDialogRequest,
  type UiExtensionDialogResponse,
} from '@pidesktop/shared';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';
import { Button, Chip, TextField } from './ui';

interface ApprovalCardProps {
  request: UiExtensionDialogRequest;
  canOperate: boolean;
  onRespond: (id: string, value: UiExtensionDialogResponse) => Promise<void>;
}

const MAX_APPROVAL_FILES = 10;
const MAX_DIFF_PREVIEW_CHARS = 1500;
const SUPPORTED_FORM_KINDS = new Set<UiElicitationField['kind']>([
  'text',
  'select',
  'multi-select',
  'number',
  'integer',
  'boolean',
]);

type FormDraftState = Record<string, string | string[] | boolean | undefined>;

function initialFormDraft(form?: UiElicitationForm): FormDraftState {
  const draft: FormDraftState = {};
  for (const field of form?.fields ?? []) {
    switch (field.kind) {
      case 'text':
        draft[field.id] = field.defaultValue ?? '';
        break;
      case 'number':
      case 'integer':
        draft[field.id] = field.defaultValue !== undefined ? String(field.defaultValue) : '';
        break;
      case 'select':
        draft[field.id] = field.defaultValue;
        break;
      case 'multi-select':
        draft[field.id] = field.defaultValue ? [...field.defaultValue] : [];
        break;
      case 'boolean':
        draft[field.id] = field.defaultValue !== undefined ? field.defaultValue : field.required ? false : undefined;
        break;
    }
  }
  return draft;
}

function scopeLabel(scope: UiApprovalScope): string {
  if (scope === 'session') return t('approval.scope.session');
  if (scope === 'workspace') return t('approval.scope.workspace');
  return t('approval.scope.once');
}

export function ApprovalCard({ request, canOperate, onRespond }: ApprovalCardProps) {
  const theme = useTheme();
  const [textValue, setTextValue] = useState(request.defaultValue ?? '');
  const [formDraft, setFormDraft] = useState<FormDraftState>(() => initialFormDraft(request.form));
  const [selectedScope, setSelectedScope] = useState<UiApprovalScope>('once');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approval = request.approval;
  const approvalFiles = approval?.files ?? [];
  const visibleFiles = approvalFiles.slice(0, MAX_APPROVAL_FILES);
  const hiddenFileCount = Math.max(0, approvalFiles.length - visibleFiles.length);
  const hasDetails = Boolean(
    request.message ||
      request.form?.description ||
      approval?.command ||
      approval?.cwd ||
      approval?.source ||
      visibleFiles.length > 0,
  );

  const formSupported = useMemo(() => {
    if (request.kind !== 'form') return true;
    if (!request.form || !Array.isArray(request.form.fields)) return false;
    return request.form.fields.every((field) => SUPPORTED_FORM_KINDS.has(field.kind));
  }, [request]);

  const submit = async (value: UiExtensionDialogResponse) => {
    if (!canOperate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(request.id, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitForm = () => {
    if (!request.form) return;
    const content: Record<string, UiElicitationValue> = {};
    for (const field of request.form.fields) {
      const raw = formDraft[field.id];
      switch (field.kind) {
        case 'text': {
          const str = typeof raw === 'string' ? raw : '';
          if (str === '' && !field.required && field.defaultValue === undefined) break;
          content[field.id] = str;
          break;
        }
        case 'number':
        case 'integer': {
          const trimmed = typeof raw === 'string' ? raw.trim() : '';
          if (!trimmed) {
            if (field.required) {
              setError(t('approval.fieldRequired', { field: field.title }));
              return;
            }
            break;
          }
          const num = Number(trimmed);
          if (!Number.isFinite(num) || (field.kind === 'integer' && !Number.isInteger(num))) {
            setError(t(field.kind === 'integer' ? 'approval.fieldInvalidInteger' : 'approval.fieldInvalidNumber', { field: field.title }));
            return;
          }
          content[field.id] = num;
          break;
        }
        case 'boolean': {
          if (typeof raw === 'boolean') {
            content[field.id] = raw;
          }
          break;
        }
        case 'select': {
          if (typeof raw === 'string' && raw.length > 0) {
            content[field.id] = raw;
          }
          break;
        }
        case 'multi-select': {
          const list = Array.isArray(raw) ? raw : [];
          if (list.length > 0 || field.required) {
            content[field.id] = list;
          }
          break;
        }
      }
    }

    try {
      const validated = requireElicitationResponse(request.form, { action: 'accept', content });
      void submit(validated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const agentOptions = approval?.agentOptions ?? [];
  const hasRejectOption = agentOptions.some((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
  const approvalScopes = approval?.scopes && approval.scopes.length > 1 ? approval.scopes : null;
  const fieldBg = { backgroundColor: theme.bg };

  const setField = (id: string, value: FormDraftState[string]) => setFormDraft((prev) => ({ ...prev, [id]: value }));

  let actions: React.ReactNode;
  if (!canOperate) {
    actions = <Text style={[styles.hint, { color: theme.textMuted }]}>{t('approval.readOnly')}</Text>;
  } else if (request.kind === 'confirm' && agentOptions.length > 0) {
    actions = (
      <View style={styles.column}>
        {agentOptions.map((option) => {
          const isAllow = option.kind === 'allow_once' || option.kind === 'allow_always';
          const isReject = option.kind === 'reject_once' || option.kind === 'reject_always';
          return (
            <Button
              key={option.id}
              label={option.label}
              compact
              variant={isAllow ? 'primary' : isReject ? 'danger' : 'secondary'}
              style={isAllow ? null : fieldBg}
              disabled={submitting}
              onPress={() => void submit({ optionId: option.id })}
            />
          );
        })}
        {!hasRejectOption ? (
          <Button label={t('common.cancel')} compact variant="ghost" disabled={submitting} onPress={() => void submit(null)} />
        ) : null}
      </View>
    );
  } else if (request.kind === 'confirm') {
    actions = (
      <View style={styles.column}>
        {approvalScopes ? (
          <View style={styles.chipWrap}>
            {approvalScopes.map((scope) => (
              <Chip
                key={scope}
                label={scopeLabel(scope)}
                selected={selectedScope === scope}
                disabled={submitting}
                onPress={() => setSelectedScope(scope)}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.row}>
          <Button
            label={t('approval.deny')}
            compact
            variant="secondary"
            style={[styles.flex, fieldBg]}
            disabled={submitting}
            onPress={() => void submit(approval ? { approved: false, scope: 'once' } : false)}
          />
          <Button
            label={t('approval.approve')}
            compact
            style={styles.flex}
            disabled={submitting}
            onPress={() => void submit(approval ? { approved: true, scope: selectedScope } : true)}
          />
        </View>
      </View>
    );
  } else if (request.kind === 'select') {
    actions =
      request.options && request.options.length > 0 ? (
        <View style={styles.column}>
          {request.options.map((option, idx) => (
            <Button
              key={`${option}-${idx}`}
              label={option}
              compact
              variant={idx === 0 ? 'primary' : 'secondary'}
              style={idx === 0 ? null : fieldBg}
              disabled={submitting}
              onPress={() => void submit(option)}
            />
          ))}
          <Button label={t('common.cancel')} compact variant="ghost" disabled={submitting} onPress={() => void submit(null)} />
        </View>
      ) : (
        <View style={styles.column}>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{t('approval.noChoices')}</Text>
          <Button label={t('common.dismiss')} compact variant="secondary" style={fieldBg} disabled={submitting} onPress={() => void submit(null)} />
        </View>
      );
  } else if (request.kind === 'form') {
    actions =
      formSupported && request.form ? (
        <View style={styles.column}>
          <ScrollView style={styles.formScroll} nestedScrollEnabled contentContainerStyle={styles.formFields}>
            {request.form.fields.map((field) => {
              const value = formDraft[field.id];
              return (
                <View key={field.id} style={styles.field}>
                  <Text style={[styles.fieldLabel, { color: theme.text }]}>
                    {field.title}
                    {field.required ? ' *' : ''}
                  </Text>
                  {field.description ? <Text style={[styles.fieldHint, { color: theme.textMuted }]}>{field.description}</Text> : null}

                  {field.kind === 'text' ? (
                    <TextField
                      value={typeof value === 'string' ? value : ''}
                      onChangeText={(text) => setField(field.id, text)}
                      placeholder={field.title}
                      style={fieldBg}
                    />
                  ) : null}

                  {field.kind === 'number' || field.kind === 'integer' ? (
                    <TextField
                      value={typeof value === 'string' ? value : ''}
                      onChangeText={(text) => setField(field.id, text)}
                      keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                      placeholder={field.kind === 'integer' ? t('approval.enterInteger') : t('approval.enterNumber')}
                      style={fieldBg}
                    />
                  ) : null}

                  {field.kind === 'boolean' ? (
                    <View style={styles.chipWrap}>
                      {[
                        { label: t('approval.yes'), val: true },
                        { label: t('approval.no'), val: false },
                      ].map((opt) => (
                        <Chip
                          key={opt.label}
                          label={opt.label}
                          selected={value === opt.val}
                          disabled={submitting}
                          onPress={() => setField(field.id, opt.val)}
                        />
                      ))}
                    </View>
                  ) : null}

                  {field.kind === 'select' ? (
                    <View style={styles.chipWrap}>
                      {field.choices.map((choice) => (
                        <Chip
                          key={choice.value}
                          label={choice.title}
                          selected={value === choice.value}
                          disabled={submitting}
                          onPress={() => setField(field.id, choice.value)}
                        />
                      ))}
                    </View>
                  ) : null}

                  {field.kind === 'multi-select' ? (
                    <View style={styles.chipWrap}>
                      {field.choices.map((choice) => {
                        const current = Array.isArray(value) ? value : [];
                        const selected = current.includes(choice.value);
                        return (
                          <Chip
                            key={choice.value}
                            label={choice.title}
                            selected={selected}
                            disabled={submitting}
                            onPress={() =>
                              setField(field.id, selected ? current.filter((item) => item !== choice.value) : [...current, choice.value])
                            }
                          />
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.row}>
            <Button label={t('common.cancel')} compact variant="ghost" style={styles.flex} disabled={submitting} onPress={() => void submit(null)} />
            <Button
              label={t('approval.decline')}
              compact
              variant="secondary"
              style={[styles.flex, fieldBg]}
              disabled={submitting}
              onPress={() => void submit({ action: 'decline' })}
            />
            <Button label={t('common.submit')} compact style={styles.flex} disabled={submitting} onPress={handleSubmitForm} />
          </View>
        </View>
      ) : (
        <View style={styles.column}>
          <Text style={[styles.hint, { color: theme.textSubtle }]}>{t('approval.formUnsupported')}</Text>
          <View style={styles.row}>
            <Button label={t('common.cancel')} compact variant="ghost" style={styles.flex} disabled={submitting} onPress={() => void submit(null)} />
            <Button
              label={t('approval.decline')}
              compact
              variant="secondary"
              style={[styles.flex, fieldBg]}
              disabled={submitting}
              onPress={() => void submit({ action: 'decline' })}
            />
          </View>
        </View>
      );
  } else {
    actions = (
      <View style={styles.column}>
        <TextField
          value={textValue}
          onChangeText={setTextValue}
          placeholder={request.placeholder ?? t('approval.placeholder')}
          multiline={request.kind === 'editor'}
          style={[fieldBg, request.kind === 'editor' ? styles.editor : null]}
        />
        <View style={styles.row}>
          <Button
            label={t('common.cancel')}
            compact
            variant="secondary"
            style={[styles.flex, fieldBg]}
            disabled={submitting}
            onPress={() => void submit(null)}
          />
          <Button label={t('common.submit')} compact style={styles.flex} disabled={submitting} onPress={() => void submit(textValue)} />
        </View>
      </View>
    );
  }

  const kicker = approval ? t('approval.required') : request.kind === 'form' ? t('approval.form') : t('approval.input');

  return (
    <View style={[styles.card, { backgroundColor: theme.warningSoft }]}>
      <Text style={[styles.kicker, { color: theme.warning }]}>{kicker}</Text>
      <Text style={[styles.title, { color: theme.text }]} numberOfLines={3}>
        {request.title}
      </Text>

      {hasDetails ? (
        <ScrollView style={styles.body} nestedScrollEnabled contentContainerStyle={styles.bodyContent}>
          {approval?.source ? <Text style={[styles.meta, { color: theme.textMuted }]}>{t('approval.source', { source: approval.source })}</Text> : null}
          {approval?.cwd ? (
            <Text style={[styles.metaMono, { color: theme.textSubtle }]} numberOfLines={2}>
              {approval.cwd}
            </Text>
          ) : null}
          {approval?.command ? (
            <Text style={[styles.code, { backgroundColor: theme.bg, color: theme.text }]} selectable>
              {approval.command}
            </Text>
          ) : null}
          {visibleFiles.map((file, index) => {
            const truncated = Boolean(file.diff && file.diff.length > MAX_DIFF_PREVIEW_CHARS);
            const diffText = file.diff ? file.diff.slice(0, MAX_DIFF_PREVIEW_CHARS) : null;
            return (
              <View key={`${file.path}-${index}`} style={[styles.file, { backgroundColor: theme.bg }]}>
                <Text style={[styles.filePath, { color: theme.text }]} numberOfLines={2}>
                  {file.path}
                </Text>
                {diffText ? (
                  <Text style={[styles.diff, { color: theme.textSubtle }]}>
                    {diffText}
                    {truncated ? `\n${t('approval.diffTruncated')}` : ''}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {hiddenFileCount > 0 ? <Text style={[styles.meta, { color: theme.textMuted }]}>{t('approval.moreFiles', { n: hiddenFileCount })}</Text> : null}
          {request.message ? <Text style={[styles.message, { color: theme.textSubtle }]}>{request.message}</Text> : null}
          {request.form?.description ? <Text style={[styles.message, { color: theme.textSubtle }]}>{request.form.description}</Text> : null}
        </ScrollView>
      ) : null}

      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

      {actions}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.md, marginBottom: space.sm, padding: space.md, borderRadius: radius.lg, gap: space.sm },
  kicker: { fontSize: font.caption, fontWeight: '700' },
  title: { fontSize: font.body, fontWeight: '600' },
  body: { maxHeight: 180 },
  bodyContent: { gap: 6 },
  meta: { fontSize: font.caption },
  metaMono: { fontFamily: 'monospace', fontSize: 11 },
  code: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17, padding: space.sm, borderRadius: radius.sm, overflow: 'hidden' },
  file: { padding: space.sm, borderRadius: radius.sm, gap: 4 },
  filePath: { fontFamily: 'monospace', fontSize: 11, fontWeight: '700' },
  diff: { fontFamily: 'monospace', fontSize: 10, lineHeight: 14 },
  message: { fontSize: font.small, lineHeight: 19 },
  hint: { fontSize: font.small, lineHeight: 18 },
  error: { fontSize: font.small },
  row: { flexDirection: 'row', gap: space.sm },
  column: { gap: space.sm },
  flex: { flex: 1 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  formScroll: { maxHeight: 220 },
  formFields: { gap: space.md },
  field: { gap: 6 },
  fieldLabel: { fontSize: font.small, fontWeight: '600' },
  fieldHint: { fontSize: font.caption },
  editor: { minHeight: 72, textAlignVertical: 'top' },
});
