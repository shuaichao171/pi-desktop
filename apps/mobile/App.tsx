import React, { useCallback, useEffect, useState } from 'react';
import { Alert, BackHandler, StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { parseRemotePairingUrl } from '@pidesktop/shared/remoteAccess';
import { RemoteProvider, useRemote } from './src/runtime/remoteStore';
import { useTheme } from './src/theme';
import { t } from './src/i18n';
import { EnvironmentsScreen } from './src/screens/EnvironmentsScreen';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { WorkspaceScreen } from './src/screens/WorkspaceScreen';

/** Pages pushed on top of the root: the conversation list, or the computers page before anything is paired. */
type Route = 'chat' | 'files' | 'hosts';

function MobileShell() {
  const theme = useTheme();
  const { hydrated, environments, pairHost } = useRemote();
  const [stack, setStack] = useState<Route[]>([]);

  // With nothing paired the computers page is the whole app; pairing swaps the root to the conversation list.
  const welcome = hydrated && environments.length === 0;
  useEffect(() => {
    if (welcome) setStack([]);
  }, [welcome]);

  const push = useCallback((route: Route) => setStack((prev) => [...prev, route]), []);
  const pop = useCallback(() => setStack((prev) => prev.slice(0, -1)), []);
  const openChat = useCallback(() => setStack(['chat']), []);

  // Android back walks the stack before leaving the app. Screens that show an inner page register their own
  // handler later, and later handlers run first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length === 0) return false;
      pop();
      return true;
    });
    return () => sub.remove();
  }, [stack.length, pop]);

  // Support opening pidesktop://pair?... links directly into the app
  useEffect(() => {
    let cancelled = false;
    const handleUrl = (url: string | null) => {
      if (cancelled || !url) return;
      const parsed = parseRemotePairingUrl(url);
      if (!parsed) return;
      const target = parsed.label ? `${parsed.label}\n${parsed.endpointUrl}` : parsed.endpointUrl;
      Alert.alert(t('hosts.pairConfirmTitle'), t('hosts.pairConfirmBody', { name: target }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('hosts.pairConfirm'),
          onPress: () => {
            void pairHost({ pairingUrlOrAddress: url })
              .then(() => setStack([]))
              .catch((err) => Alert.alert(t('hosts.pairFailed'), err instanceof Error ? err.message : String(err)));
          },
        },
      ]);
    };
    void Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [pairHost]);

  const top = stack[stack.length - 1];
  let page: React.ReactNode = null;
  if (!hydrated) {
    page = null;
  } else if (welcome) {
    page = <EnvironmentsScreen onPaired={() => setStack([])} />;
  } else if (top === 'chat') {
    page = <ChatScreen onBack={pop} onOpenFiles={() => push('files')} />;
  } else if (top === 'files') {
    page = <WorkspaceScreen onBack={pop} />;
  } else if (top === 'hosts') {
    page = <EnvironmentsScreen onBack={pop} onPaired={() => setStack([])} />;
  } else {
    page = <SessionsScreen onOpenChat={openChat} onOpenHosts={() => push('hosts')} />;
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.bg }]} edges={['top', 'bottom']}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <View style={styles.content}>{page}</View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RemoteProvider>
        <MobileShell />
      </RemoteProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },
});
