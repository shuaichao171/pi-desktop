# Pi Desktop Remote (Expo / React Native)

Companion mobile app for controlling Pi Desktop over LAN, Tailscale HTTPS, or Cloudflare Tunnel.

## Architecture

- Shares wire protocol types and the multi-route connection runtime directly from `../../packages/shared/src/remoteAccess.ts` and `../../packages/shared/src/remoteClient.ts`.
- Automatically learns LAN & Tailscale routes advertised by the desktop host and promotes back to direct LAN when on the same Wi-Fi network.
- Stores per-environment session tokens in OS secure storage (`expo-secure-store`) and exchanges them for 60-second single-use WebSocket tickets before opening `/ws`.

## Local Development

Install dependencies inside `apps/mobile` (intentionally isolated from the desktop Electron pnpm workspace):

```bash
cd apps/mobile
npm install
npx expo start
```

Or build native Android / iOS dev clients:

```bash
npx expo run:android
npx expo run:ios
```

## Pairing

1. Open Pi Desktop → **Settings → Remote access**, enable the server (and optionally Tailscale HTTPS or Cloudflare Tunnel).
2. Click **Generate QR** to mint a one-time pairing code (`Full control` or `Read-only`).
3. In this app, tap **Scan QR** (or paste the `pidesktop://pair?...` link).
