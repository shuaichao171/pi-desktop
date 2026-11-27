import React, { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SavedRemoteEnvironment } from '@pidesktop/shared/remoteClient';
import { useRemote } from '../runtime/remoteStore';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';
import { QrScanner } from '../components/QrScanner';
import { Button, FadeIn, Header, SectionLabel, StatusDot, TextAction, TextField } from '../components/ui';

interface EnvironmentsScreenProps {
  onBack?: () => void;
  onPaired: () => void;
}

function HostCard({ env, onOpenChats }: { env: SavedRemoteEnvironment; onOpenChats: () => void }) {
  const theme = useTheme();
  const { activeEnvironment, connection, connectHost, disconnectHost, forgetHost, addRouteToHost } = useRemote();
  const [routesOpen, setRoutesOpen] = useState(false);
  const [routeInput, setRouteInput] = useState('');

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
  const statusText =
    phase === 'connected'
      ? t('hosts.via', { route: connection.activeRoute?.label ?? '' })
      : phase === 'connecting'
        ? t('conn.connecting')
        : phase === 'reconnecting'
          ? t('conn.reconnecting', { n: connection.attempt })
          : phase === 'auth-error'
            ? t('conn.authError')
            : isCurrent && connection.error
              ? connection.error
              : t('conn.disconnected');

  const addRoute = () => {
    const url = routeInput.trim();
    if (!url) return;
    void addRouteToHost(env.environmentId, url)
      .then(() => setRouteInput(''))
      .catch((err) => Alert.alert(t('hosts.invalidRoute'), err instanceof Error ? err.message : String(err)));
  };

  const confirmForget = () =>
    Alert.alert(t('hosts.forgetTitle'), t('hosts.forgetBody', { name: env.label }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('hosts.forget'),
        style: 'destructive',
        onPress: () =>
          void forgetHost(env.environmentId).catch((err) =>
            Alert.alert(t('common.error'), err instanceof Error ? err.message : String(err)),
          ),
      },
    ]);

  return (
    <View style={[styles.card, { backgroundColor: theme.surface }]}>
      <View style={styles.hostTop}>
        <StatusDot color={statusColor} size={9} />
        <Text style={[styles.hostName, { color: theme.text }]} numberOfLines={1}>
          {env.label}
        </Text>
        <Text style={[styles.role, { color: theme.textMuted }]}>{env.role === 'read-only' ? t('hosts.readOnly') : t('hosts.full')}</Text>
      </View>
      <Text style={[styles.status, { color: phase === 'auth-error' ? theme.danger : theme.textSubtle }]} numberOfLines={2}>
        {statusText}
      </Text>

      <View style={styles.actions}>
        {isCurrent && phase === 'connected' ? (
          <>
            <Button label={t('hosts.openChats')} compact style={styles.flex} onPress={onOpenChats} />
            <Button label={t('hosts.disconnect')} compact variant="secondary" style={{ backgroundColor: theme.raised }} onPress={disconnectHost} />
          </>
        ) : isCurrent && (phase === 'connecting' || phase === 'reconnecting') ? (
          <Button
            label={phase === 'reconnecting' ? t('hosts.cancelReconnect') : t('hosts.cancelConnect')}
            compact
            variant="secondary"
            style={[styles.flex, { backgroundColor: theme.raised }]}
            onPress={disconnectHost}
          />
        ) : (
          <Button label={t('hosts.connect')} compact style={styles.flex} onPress={() => connectHost(env)} />
        )}
      </View>

      <Pressable onPress={() => setRoutesOpen((open) => !open)} hitSlop={6} style={styles.routesToggle}>
        <Text style={{ color: theme.textSubtle, fontSize: font.small }}>
          {t('hosts.routes', { n: env.routes.length })} {routesOpen ? '▴' : '▾'}
        </Text>
      </Pressable>

      {routesOpen ? (
        <FadeIn style={styles.routes}>
          {env.routes.map((route) => {
            const active = isCurrent && connection.activeRoute?.id === route.id;
            return (
              <View key={route.id} style={styles.routeRow}>
                <StatusDot color={active ? theme.success : theme.border} size={6} />
                <View style={styles.flex}>
                  <Text style={{ color: theme.text, fontSize: font.small, fontWeight: active ? '600' : '400' }}>
                    {route.label}
                    {route.learned ? ` · ${t('hosts.auto')}` : ''}
                    {active ? ` · ${t('hosts.inUse')}` : ''}
                  </Text>
                  <Text style={[styles.routeUrl, { color: theme.textMuted }]} numberOfLines={1}>
                    {route.httpBaseUrl}
                  </Text>
                </View>
              </View>
            );
          })}
          <View style={styles.addRoute}>
            <TextField
              value={routeInput}
              onChangeText={setRouteInput}
              placeholder={env.pairedOverHttps ? t('hosts.addRouteHttpsPlaceholder') : t('hosts.addRoutePlaceholder')}
              style={[styles.flex, { backgroundColor: theme.bg, fontSize: font.small }]}
              onSubmitEditing={addRoute}
            />
            <TextAction label={t('hosts.addRoute')} onPress={addRoute} disabled={!routeInput.trim()} />
          </View>
          <View style={styles.forget}>
            <TextAction label={t('hosts.forget')} tone="danger" onPress={confirmForget} />
          </View>
        </FadeIn>
      ) : null}
    </View>
  );
}

export function EnvironmentsScreen({ onBack, onPaired }: EnvironmentsScreenProps) {
  const theme = useTheme();
  const { environments, pairHost } = useRemote();

  const [scannerOpen, setScannerOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pairingInput, setPairingInput] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pairingBusyRef = useRef(false);

  const handlePair = async (urlOrAddr: string, code?: string) => {
    if (pairingBusyRef.current) return;
    pairingBusyRef.current = true;
    setPairingBusy(true);
    setError(null);
    try {
      await pairHost({ pairingUrlOrAddress: urlOrAddr, code });
      setPairingInput('');
      setManualCode('');
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  };

  if (scannerOpen) {
    return (
      <QrScanner
        onClose={() => setScannerOpen(false)}
        onScanned={(url) => {
          setScannerOpen(false);
          void handlePair(url);
        }}
      />
    );
  }

  const welcome = environments.length === 0;
  const needsCode = pairingInput.trim().length > 0 && !pairingInput.trim().startsWith('pidesktop://');

  const pairControls = (
    <View style={styles.pair}>
      <Button
        label={pairingBusy ? t('hosts.pairing') : t('hosts.scan')}
        loading={pairingBusy}
        variant={welcome ? 'primary' : 'secondary'}
        onPress={() => setScannerOpen(true)}
      />
      {linkOpen ? (
        <FadeIn style={styles.linkForm}>
          <TextField value={pairingInput} onChangeText={setPairingInput} placeholder={t('hosts.pastePlaceholder')} />
          {needsCode ? <TextField value={manualCode} onChangeText={setManualCode} placeholder={t('hosts.codePlaceholder')} /> : null}
          <Button
            label={t('hosts.pair')}
            variant="secondary"
            disabled={pairingBusy || !pairingInput.trim()}
            onPress={() => void handlePair(pairingInput, manualCode || undefined)}
          />
        </FadeIn>
      ) : (
        <View style={styles.center}>
          <TextAction
            label={t('hosts.pasteToggle')}
            onPress={() => setLinkOpen(true)}
          />
        </View>
      )}
      {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Header title={t('hosts.title')} onBack={onBack} large={!onBack} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {welcome ? (
          <View style={styles.hero}>
            <Text style={[styles.heroTitle, { color: theme.text }]}>{t('hosts.welcome')}</Text>
            <Text style={[styles.heroHint, { color: theme.textSubtle }]}>{t('hosts.welcomeHint')}</Text>
            {pairControls}
          </View>
        ) : (
          <>
            <SectionLabel>{t('hosts.paired')}</SectionLabel>
            <View style={styles.cards}>
              {environments.map((env) => (
                <HostCard key={env.environmentId} env={env} onOpenChats={onBack ?? onPaired} />
              ))}
            </View>
            <SectionLabel>{t('hosts.addAnother')}</SectionLabel>
            <View style={styles.cards}>{pairControls}</View>
          </>
        )}
        <Text style={[styles.footnote, { color: theme.textMuted }]}>{t('hosts.routesHint')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { alignItems: 'center', paddingVertical: space.xs },
  content: { paddingBottom: space.xl },
  hero: { paddingHorizontal: space.xl, paddingTop: space.xl, gap: space.md },
  heroTitle: { fontSize: font.title, fontWeight: '700' },
  heroHint: { fontSize: font.body, lineHeight: 22, marginBottom: space.md },
  cards: { paddingHorizontal: space.lg, gap: space.md },
  card: { borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  hostTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  hostName: { flex: 1, fontSize: font.heading, fontWeight: '600' },
  role: { fontSize: font.caption },
  status: { fontSize: font.small },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  routesToggle: { alignSelf: 'flex-start', paddingTop: space.xs },
  routes: { gap: space.sm },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  routeUrl: { fontSize: 11, fontFamily: 'monospace' },
  addRoute: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  forget: { alignItems: 'flex-start', paddingTop: space.xs },
  pair: { gap: space.sm },
  linkForm: { gap: space.sm },
  error: { fontSize: font.small },
  footnote: { fontSize: font.caption, lineHeight: 18, paddingHorizontal: space.xl, paddingTop: space.xl },
});
