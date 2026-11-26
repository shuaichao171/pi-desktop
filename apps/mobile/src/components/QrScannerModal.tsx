import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseRemotePairingUrl } from '@pidesktop/shared/remoteAccess';
import { useTheme } from '../theme';

interface QrScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScanned: (pairingUrl: string) => void;
}

export function QrScannerModal({ visible, onClose, onScanned }: QrScannerModalProps) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const handleBarcode = ({ data }: { data: string }) => {
    if (scanned) return;
    const parsed = parseRemotePairingUrl(data);
    if (!parsed) return;
    setScanned(true);
    onScanned(data);
    setTimeout(() => setScanned(false), 1200);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>Scan Desktop QR Code</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={{ color: theme.brand, fontWeight: '600', fontSize: 16 }}>Close</Text>
          </Pressable>
        </View>

        {!permission?.granted ? (
          <View style={styles.permissionBox}>
            <Text style={[styles.hint, { color: theme.textSubtle }]}>
              Camera permission is needed to scan pairing QR codes from Pi Desktop.
            </Text>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: theme.brand }]}
              onPress={() => void requestPermission()}
            >
              <Text style={{ color: theme.brandInk, fontWeight: '600' }}>Grant Camera Access</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcode}
            />
            <View style={styles.overlay}>
              <View style={[styles.reticle, { borderColor: theme.brand }]} />
              <Text style={styles.overlayText}>Point at the QR code in Pi Desktop Settings → Remote access</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingBottom: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  closeBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  permissionBox: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 16 },
  hint: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
  primaryBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  cameraWrap: { flex: 1, position: 'relative' },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 18, padding: 24 },
  reticle: { width: 240, height: 240, borderWidth: 3, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.08)' },
  overlayText: {
    color: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    fontSize: 13,
    textAlign: 'center',
  },
});
