import { Clipboard, Platform, ToastAndroid } from 'react-native';
import { t } from '../i18n';

/**
 * Copies text and confirms it. React Native's built-in Clipboard is deprecated but still ships in 0.79;
 * switch to expo-clipboard when upgrading past it.
 */
export function copyText(text: string): void {
  Clipboard.setString(text);
  // Android 13+ shows its own clipboard preview, so a toast there would say the same thing twice.
  if (Platform.OS === 'android' && Number(Platform.Version) < 33) {
    ToastAndroid.show(t('common.copied'), ToastAndroid.SHORT);
  }
}
