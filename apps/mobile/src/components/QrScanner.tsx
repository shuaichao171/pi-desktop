import React, { useEffect, useRef } from 'react';
import { BackHandler, Linking, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseRemotePairingUrl } from '@pidesktop/shared/remoteAccess';
import { font, radius, space, useTheme } from '../theme';
import { t } from '../i18n';
import { Button, EmptyState, Header } from './ui';

interface QrScannerProps {
  onClose: () => void;
  onScanned: (pairingUrl: string) => void;
}

/** Full-page scanner shown in place of the computers page, so it sits inside the app's safe area. */
export function QrScanner({ onClose, onScanned }: QrScannerProps) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const handleBarcode = ({ data }: { data: string }) => {
    if (scannedRef.current || !parseRemotePairingUrl(data)) return;
    scannedRef.current = true;
    onScanned(data);
  };

  const permanentlyDenied = Boolean(permission && !permission.granted && !permission.canAskAgain);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Header title={t('qr.title')} onBack={onClose} />
      {!permission?.granted ? (
        <EmptyState
          title={permanentlyDenied ? t('qr.permissionDenied') : t('qr.permission')}
          action={
            permanentlyDenied ? (
              <Button label={t('qr.openSettings')} onPress={() => void Linking.openSettings()} />
            ) : (
              <Button label={t('qr.grant')} onPress={() => void requestPermission()} />
            )
          }
        />
      ) : (
        <View style={styles.cameraWrap}>
          <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={handleBarcode} />
          <View style={styles.overlay}>
            <View style={styles.reticle} />
            <Text style={styles.overlayText}>{t('qr.hint')}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  cameraWrap: { flex: 1, marginHorizontal: space.lg, marginBottom: space.lg, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000' },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg, padding: space.xl },
  reticle: { width: 230, height: 230, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)', borderRadius: radius.lg },
  overlayText: {
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    fontSize: font.small,
    textAlign: 'center',
    overflow: 'hidden',
  },
});
