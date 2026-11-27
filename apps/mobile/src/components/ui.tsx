import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';

/**
 * Wraps a section that has just been expanded so it eases in instead of popping. LayoutAnimation is avoided
 * on purpose: under the new architecture on Android it can leave a later-opened modal half transparent.
 */
export function FadeIn({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [progress]);
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] });
  return <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

/** Top bar shared by every page: optional back arrow, a title that can open something, and trailing actions. */
export function Header({
  title,
  subtitle,
  onBack,
  onTitlePress,
  right,
  large,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onTitlePress?: () => void;
  right?: React.ReactNode;
  /** Root pages use a larger title; pushed pages use a compact one next to the back arrow. */
  large?: boolean;
}) {
  const theme = useTheme();
  const titleBlock = (
    <View style={styles.headerCopy}>
      <Text
        style={[styles.headerTitle, { color: theme.text, fontSize: large ? font.title : font.heading }]}
        numberOfLines={1}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.headerSubtitle, { color: theme.textMuted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
  return (
    <View style={[styles.header, { backgroundColor: theme.bg }]}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          style={({ pressed }) => [styles.backBtn, pressed && { backgroundColor: theme.surface }]}
        >
          <Text style={[styles.backGlyph, { color: theme.text }]}>‹</Text>
        </Pressable>
      ) : null}
      {onTitlePress ? (
        <Pressable onPress={onTitlePress} style={({ pressed }) => [styles.headerCopy, pressed && { opacity: 0.6 }]}>
          {titleBlock}
        </Pressable>
      ) : (
        titleBlock
      )}
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  compact,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const palette: Record<ButtonVariant, { bg: string; fg: string }> = {
    primary: { bg: theme.brand, fg: theme.brandInk },
    secondary: { bg: theme.surface, fg: theme.text },
    ghost: { bg: 'transparent', fg: theme.brand },
    danger: { bg: 'transparent', fg: theme.danger },
  };
  const colors = palette[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        compact ? styles.buttonCompact : null,
        { backgroundColor: colors.bg, opacity: inactive ? 0.45 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.fg} /> : null}
      <Text style={[styles.buttonLabel, { color: colors.fg, fontSize: compact ? font.small : font.body }]}>{label}</Text>
    </Pressable>
  );
}

/** Small pressable text, used for row-level actions such as "Steer" or "Remove". */
export function TextAction({
  label,
  onPress,
  tone = 'brand',
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: 'brand' | 'danger' | 'muted';
  disabled?: boolean;
}) {
  const theme = useTheme();
  const color = tone === 'danger' ? theme.danger : tone === 'muted' ? theme.textSubtle : theme.brand;
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8} style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}>
      <Text style={{ color, fontSize: font.small, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? theme.text : theme.surface, opacity: disabled && !selected ? 0.45 : pressed ? 0.75 : 1 },
      ]}
    >
      <Text style={{ color: selected ? theme.bg : theme.textSubtle, fontSize: font.small, fontWeight: selected ? '600' : '500' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: theme.surface }]}>
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[styles.segment, selected && { backgroundColor: theme.raised, elevation: theme.dark ? 0 : 1 }]}
          >
            <Text style={{ color: selected ? theme.text : theme.textSubtle, fontSize: font.small, fontWeight: selected ? '600' : '500' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function TextField({ style, ...props }: TextInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[styles.field, { backgroundColor: theme.surface, color: theme.text }, style]}
    />
  );
}

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Separator({ inset = space.lg }: { inset?: number }) {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: inset }} />;
}

export function SectionLabel({ children }: { children: string }) {
  const theme = useTheme();
  return <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>{children}</Text>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: theme.textSubtle }]}>{title}</Text>
      {hint ? <Text style={[styles.emptyHint, { color: theme.textMuted }]}>{hint}</Text> : null}
      {action}
    </View>
  );
}

/** One-line notice under a header: connection trouble, pending approvals, errors. */
export function Banner({
  text,
  tone = 'warning',
  onPress,
  actionLabel,
}: {
  text: string;
  tone?: 'warning' | 'danger' | 'info';
  onPress?: () => void;
  actionLabel?: string;
}) {
  const theme = useTheme();
  const bg = tone === 'info' ? theme.brandSoft : theme.warningSoft;
  const fg = tone === 'danger' ? theme.danger : tone === 'info' ? theme.brand : theme.warning;
  const body = (
    <>
      <Text style={[styles.bannerText, { color: tone === 'info' ? theme.text : fg }]} numberOfLines={2}>
        {text}
      </Text>
      {actionLabel ? <Text style={{ color: fg, fontSize: font.small, fontWeight: '700' }}>{actionLabel}</Text> : null}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.banner, { backgroundColor: bg, opacity: pressed ? 0.75 : 1 }]}>
      {body}
    </Pressable>
  ) : (
    <View style={[styles.banner, { backgroundColor: bg }]}>{body}</View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    marginLeft: -space.sm,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { fontSize: 30, lineHeight: 32, marginTop: -3 },
  headerCopy: { flex: 1, justifyContent: 'center' },
  headerTitle: { fontWeight: '700' },
  headerSubtitle: { fontSize: font.caption, marginTop: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  button: {
    minHeight: 46,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  buttonCompact: { minHeight: 34, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonLabel: { fontWeight: '600' },
  chip: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, maxWidth: 200 },
  segmented: { flexDirection: 'row', borderRadius: radius.md, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.sm + 1 },
  field: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: font.body,
  },
  sectionLabel: { fontSize: font.caption, fontWeight: '600', paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  empty: { alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: 56, gap: space.sm },
  emptyTitle: { fontSize: font.body, fontWeight: '600', textAlign: 'center' },
  emptyHint: { fontSize: font.small, lineHeight: 19, textAlign: 'center', marginBottom: space.sm },
  banner: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  bannerText: { flex: 1, fontSize: font.small, lineHeight: 18 },
});
