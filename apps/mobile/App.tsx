import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { parseRemotePairingUrl } from '@pidesktop/shared/remoteAccess';
import { RemoteProvider, useRemote } from './src/runtime/remoteStore';
import { useTheme } from './src/theme';
import { EnvironmentsScreen } from './src/screens/EnvironmentsScreen';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { WorkspaceScreen } from './src/screens/WorkspaceScreen';

type AppTab = 'hosts' | 'sessions' | 'chat' | 'workspace';

function MobileShell() {
  const theme = useTheme();
  const { connection, pendingDialogs, pairHost } = useRemote();
  const [tab, setTab] = useState<AppTab>('hosts');

  // Support opening pidesktop://pair?... links directly into the app
  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (!url) return;
      const parsed = parseRemotePairingUrl(url);
      if (!parsed) return;
      Alert.alert(
        'Pair with Desktop?',
        `Connect to ${parsed.label ?? parsed.endpointUrl}?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Pair',
            onPress: () => {
              void pairHost({ pairingUrlOrAddress: url })
                .then(() => setTab('chat'))
                .catch((err) => Alert.alert('Pairing Failed', err instanceof Error ? err.message : String(err)));
            },
          },
        ],
      );
    };
    void Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, [pairHost]);

  const navItems: Array<{ id: AppTab; label: string; badge?: number }> = [
    { id: 'hosts', label: 'Hosts' },
    { id: 'sessions', label: 'Chats' },
    { id: 'chat', label: 'Thread', badge: pendingDialogs.length },
    { id: 'workspace', label: 'Files & Git' },
  ];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.bg }]} edges={['top', 'bottom']}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <View style={styles.content}>
        {tab === 'hosts' && <EnvironmentsScreen onOpenChats={() => setTab('chat')} />}
        {tab === 'sessions' && <SessionsScreen onOpenChat={() => setTab('chat')} />}
        {tab === 'chat' && <ChatScreen />}
        {tab === 'workspace' && <WorkspaceScreen />}
      </View>

      <View style={[styles.navBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
        {navItems.map((item) => {
          const active = tab === item.id;
          return (
            <Pressable key={item.id} style={styles.navItem} onPress={() => setTab(item.id)}>
              <View style={styles.navLabelRow}>
                <Text
                  style={{
                    color: active ? theme.brand : theme.textSubtle,
                    fontWeight: active ? '700' : '500',
                    fontSize: 13,
                  }}
                >
                  {item.label}
                </Text>
                {item.id === 'hosts' && connection.phase === 'connected' && (
                  <View style={[styles.onlineDot, { backgroundColor: theme.success }]} />
                )}
                {item.badge ? (
                  <View style={[styles.badge, { backgroundColor: theme.warning }]}>
                    <Text style={styles.badgeText}>{item.badge}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
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
  navBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
  navLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  onlineDot: { width: 7, height: 7, borderRadius: 4 },
  badge: { minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#111', fontSize: 10, fontWeight: '800' },
});
