import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRemote } from '../runtime/remoteStore';
import { useTheme } from '../theme';
import { QrScannerModal } from '../components/QrScannerModal';

interface EnvironmentsScreenProps {
  onOpenChats: () => void;
}

export function EnvironmentsScreen({ onOpenChats }: EnvironmentsScreenProps) {
  const theme = useTheme();
  const {
    environments,
    activeEnvironment,
    connection,
    pairHost,
    connectHost,
    disconnectHost,
    forgetHost,
    addRouteToHost,
  } = useRemote();

  const [scannerOpen, setScannerOpen] = useState(false);
  const [pairingInput, setPairingInput] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [routeInputByEnv, setRouteInputByEnv] = useState<Record<string, string>>({});
  const [pairingBusy, setPairingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePair = async (urlOrAddr: string, code?: string) => {
    setPairingBusy(true);
    setError(null);
    try {
      await pairHost({ pairingUrlOrAddress: urlOrAddr, code });
      setPairingInput('');
      setManualCode('');
      onOpenChats();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairingBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={styles.container}>
      <Text style={[styles.heading, { color: theme.text }]}>Desktop Hosts</Text>
      <Text style={[styles.subtitle, { color: theme.textSubtle }]}>
        Pair via LAN, Tailscale HTTPS, or Cloudflare Tunnel. Learned LAN routes are automatically preferred at home.
      </Text>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.cardTitle, { color: theme.text }]}>Pair a New Desktop</Text>
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: theme.brand }]}
          disabled={pairingBusy}
          onPress={() => setScannerOpen(true)}
        >
          <Text style={{ color: theme.brandInk, fontWeight: '700', fontSize: 15 }}>
            Scan Pairing QR Code
          </Text>
        </Pressable>

        <TextInput
          value={pairingInput}
          onChangeText={setPairingInput}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste pidesktop://pair?... or https://host"
          placeholderTextColor={theme.textMuted}
          style={[styles.input, { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text }]}
        />
        {!pairingInput.trim().startsWith('pidesktop://') && pairingInput.trim().length > 0 && (
          <TextInput
            value={manualCode}
            onChangeText={setManualCode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="One-time pairing code"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, { borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text }]}
          />
        )}
        <Pressable
          style={[styles.secondaryBtn, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
          disabled={pairingBusy || !pairingInput.trim()}
          onPress={() => void handlePair(pairingInput, manualCode || undefined)}
        >
          <Text style={{ color: theme.text, fontWeight: '600' }}>
            {pairingBusy ? 'Pairing…' : 'Connect with Link / Code'}
          </Text>
        </Pressable>
        {error ? <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text> : null}
      </View>

      {environments.length === 0 ? (
        <View style={[styles.emptyBox, { borderColor: theme.border }]}>
          <Text style={{ color: theme.textSubtle, textAlign: 'center' }}>
            No paired desktops yet. Open Pi Desktop → Settings → Remote access to generate a QR code.
          </Text>
        </View>
      ) : (
        environments.map((env) => {
          const isCurrent = activeEnvironment?.environmentId === env.environmentId;
          const phase = isCurrent ? connection.phase : 'disconnected';
          const statusColor =
            phase === 'connected'
              ? theme.success
              : phase === 'connecting' || phase === 'reconnecting'
                ? theme.warning
                : phase === 'auth-error'
                  ? theme.danger
                  : theme.textMuted;

          return (
            <View
              key={env.environmentId}
              style={[
                styles.card,
                {
                  backgroundColor: theme.surface,
                  borderColor: isCurrent ? theme.brand : theme.border,
                },
              ]}
            >
              <View style={styles.hostHeader}>
                <View style={styles.hostTitleRow}>
                  <View style={[styles.dot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.hostName, { color: theme.text }]}>{env.label}</Text>
                </View>
                <Text style={[styles.roleBadge, { color: theme.textSubtle, borderColor: theme.border }]}>
                  {env.role === 'read-only' ? 'Read-only' : 'Full'}
                </Text>
              </View>

              <Text style={{ color: theme.textSubtle, fontSize: 12 }}>
                {isCurrent
                  ? phase === 'connected'
                    ? `Connected via ${connection.activeRoute?.label ?? 'route'}`
                    : `${phase}${connection.error ? ` · ${connection.error}` : ''}`
                  : `${env.routes.length} saved route(s)`}
              </Text>

              <View style={styles.routesList}>
                {env.routes.map((route) => {
                  const active = isCurrent && connection.activeRoute?.id === route.id;
                  return (
                    <View
                      key={route.id}
                      style={[
                        styles.routeRow,
                        {
                          borderColor: active ? theme.success : theme.border,
                          backgroundColor: theme.surfaceAlt,
                        },
                      ]}
                    >
                      <Text style={{ color: theme.text, fontSize: 12, fontWeight: active ? '700' : '500' }}>
                        {route.label} {route.learned ? '(auto)' : ''} {active ? '· In use' : ''}
                      </Text>
                      <Text style={{ color: theme.textMuted, fontSize: 11, fontFamily: 'monospace' }}>
                        {route.httpBaseUrl}
                      </Text>
                    </View>
                  );
                })}
              </View>

              <View style={styles.addRouteRow}>
                <TextInput
                  value={routeInputByEnv[env.environmentId] ?? ''}
                  onChangeText={(text) =>
                    setRouteInputByEnv((prev) => ({ ...prev, [env.environmentId]: text }))
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Add route URL (LAN / Tailscale / Tunnel)"
                  placeholderTextColor={theme.textMuted}
                  style={[
                    styles.input,
                    { flex: 1, borderColor: theme.border, backgroundColor: theme.surfaceAlt, color: theme.text },
                  ]}
                />
                <Pressable
                  style={[styles.smallBtn, { borderColor: theme.border }]}
                  onPress={() => {
                    const url = routeInputByEnv[env.environmentId]?.trim();
                    if (!url) return;
                    void addRouteToHost(env.environmentId, url)
                      .then(() => setRouteInputByEnv((prev) => ({ ...prev, [env.environmentId]: '' })))
                      .catch((err) => Alert.alert('Invalid route', err instanceof Error ? err.message : String(err)));
                  }}
                >
                  <Text style={{ color: theme.text, fontWeight: '600', fontSize: 12 }}>Add</Text>
                </Pressable>
              </View>

              <View style={styles.actionRow}>
                {isCurrent && phase === 'connected' ? (
                  <>
                    <Pressable
                      style={[styles.smallBtn, { backgroundColor: theme.brand, borderColor: theme.brand, flex: 1 }]}
                      onPress={onOpenChats}
                    >
                      <Text style={{ color: theme.brandInk, fontWeight: '600' }}>Open Chats</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.smallBtn, { borderColor: theme.border }]}
                      onPress={disconnectHost}
                    >
                      <Text style={{ color: theme.textSubtle }}>Disconnect</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    style={[styles.smallBtn, { backgroundColor: theme.brand, borderColor: theme.brand, flex: 1 }]}
                    onPress={() => connectHost(env)}
                  >
                    <Text style={{ color: theme.brandInk, fontWeight: '600' }}>Connect</Text>
                  </Pressable>
                )}
                <Pressable
                  style={[styles.smallBtn, { borderColor: theme.danger }]}
                  onPress={() =>
                    Alert.alert('Forget Desktop?', `Remove ${env.label} from this phone?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Forget', style: 'destructive', onPress: () => void forgetHost(env.environmentId) },
                    ])
                  }
                >
                  <Text style={{ color: theme.danger, fontWeight: '600' }}>Forget</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}

      <QrScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(url) => {
          setScannerOpen(false);
          void handlePair(url);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 32 },
  heading: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 13, lineHeight: 19 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  primaryBtn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  secondaryBtn: { paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 13 },
  emptyBox: { padding: 24, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed' },
  hostHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hostTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  hostName: { fontSize: 16, fontWeight: '700' },
  roleBadge: { fontSize: 11, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, borderWidth: 1 },
  routesList: { gap: 6 },
  routeRow: { padding: 8, borderRadius: 8, borderWidth: 1, gap: 2 },
  addRouteRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
  smallBtn: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
});
