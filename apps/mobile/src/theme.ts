import { useColorScheme } from 'react-native';

export interface MobileTheme {
  readonly dark: boolean;
  readonly bg: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly text: string;
  readonly textSubtle: string;
  readonly textMuted: string;
  readonly brand: string;
  readonly brandInk: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly userBubble: string;
  readonly assistantBubble: string;
  readonly diffAddBg: string;
  readonly diffAddText: string;
  readonly diffDelBg: string;
  readonly diffDelText: string;
}

const DARK_THEME: MobileTheme = {
  dark: true,
  bg: '#0f1115',
  surface: '#171a21',
  surfaceAlt: '#1f242e',
  border: '#2a303c',
  text: '#f3f5f8',
  textSubtle: '#a9b1c2',
  textMuted: '#6f788a',
  brand: '#4f8cff',
  brandInk: '#ffffff',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  userBubble: '#1f3a66',
  assistantBubble: '#171a21',
  diffAddBg: 'rgba(34, 197, 94, 0.16)',
  diffAddText: '#86efac',
  diffDelBg: 'rgba(239, 68, 68, 0.16)',
  diffDelText: '#fca5a5',
};

const LIGHT_THEME: MobileTheme = {
  dark: false,
  bg: '#f5f6f8',
  surface: '#ffffff',
  surfaceAlt: '#eef0f4',
  border: '#dde1e8',
  text: '#14171f',
  textSubtle: '#525b6d',
  textMuted: '#818a9c',
  brand: '#2563eb',
  brandInk: '#ffffff',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  userBubble: '#dbeafe',
  assistantBubble: '#ffffff',
  diffAddBg: 'rgba(22, 163, 74, 0.14)',
  diffAddText: '#166534',
  diffDelBg: 'rgba(220, 38, 38, 0.14)',
  diffDelText: '#991b1b',
};

export function useTheme(): MobileTheme {
  const scheme = useColorScheme();
  return scheme === 'light' ? LIGHT_THEME : DARK_THEME;
}
