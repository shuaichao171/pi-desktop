import { useColorScheme } from 'react-native';

export interface MobileTheme {
  readonly dark: boolean;
  /** Page background. */
  readonly bg: string;
  /** Raised or filled areas: inputs, user bubbles, sheets. */
  readonly surface: string;
  /** Pressed rows and selected chips. */
  readonly surfaceAlt: string;
  readonly border: string;
  readonly text: string;
  readonly textSubtle: string;
  readonly textMuted: string;
  readonly brand: string;
  readonly brandInk: string;
  /** Tinted background for the selected item and brand notices. */
  readonly brandSoft: string;
  readonly success: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly danger: string;
  readonly userBubble: string;
  readonly diffAddBg: string;
  readonly diffAddText: string;
  readonly diffDelBg: string;
  readonly diffDelText: string;
}

const LIGHT_THEME: MobileTheme = {
  dark: false,
  bg: '#ffffff',
  surface: '#f4f5f7',
  surfaceAlt: '#eaecf0',
  border: '#e4e6eb',
  text: '#15171c',
  textSubtle: '#5a606c',
  textMuted: '#959ba6',
  brand: '#2563eb',
  brandInk: '#ffffff',
  brandSoft: '#eef3ff',
  success: '#16a34a',
  warning: '#d97706',
  warningSoft: '#fff7e8',
  danger: '#dc2626',
  userBubble: '#eef3ff',
  diffAddBg: 'rgba(22, 163, 74, 0.12)',
  diffAddText: '#166534',
  diffDelBg: 'rgba(220, 38, 38, 0.12)',
  diffDelText: '#991b1b',
};

const DARK_THEME: MobileTheme = {
  dark: true,
  bg: '#0e0f12',
  surface: '#1a1c21',
  surfaceAlt: '#24272e',
  border: '#272a31',
  text: '#eceef2',
  textSubtle: '#a4aab5',
  textMuted: '#6c7280',
  brand: '#5b8cff',
  brandInk: '#ffffff',
  brandSoft: '#1a2540',
  success: '#22c55e',
  warning: '#f59e0b',
  warningSoft: '#2a2112',
  danger: '#f05252',
  userBubble: '#1d2a47',
  diffAddBg: 'rgba(34, 197, 94, 0.14)',
  diffAddText: '#86efac',
  diffDelBg: 'rgba(239, 68, 68, 0.14)',
  diffDelText: '#fca5a5',
};

/** Spacing, radii and type sizes shared by every screen, so pages line up without per-screen numbers. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const font = { title: 22, heading: 17, body: 15, small: 13, caption: 12 } as const;

export function useTheme(): MobileTheme {
  return useColorScheme() === 'dark' ? DARK_THEME : LIGHT_THEME;
}
