---
name: wallet-flow
description: Use when the demo needs the real Heka Wallet - starting the Android emulator, launching the app, linking the wallet by its public DID, sending it the Finance Data Officer credential from the TrustCo Console, and presenting to the agent or the authorization server with "Send to wallet". Covers the LAN-address setup for Heka, the Windows build traps and the short presentation window.
---

# Driving the real wallet

The demo runs without a wallet (the in-process holder presents instead), and that is the right
choice for development. Use a real wallet when human-in-the-loop is the thing being shown —
because who presented a credential is the subject of this demo, and a simulation cannot make that
point.

Everything reaches the phone over **DIDComm**: the Trust Lens and the TrustCo Console send basic
messages to the wallet's public `did:peer:2` through its cloud mediator (`src/shared/wallet-link.ts`,
after `demo/a2a-oid4vp`). No `adb` is involved in the flow. The wallet needs internet for the
mediator; so does the host.

## Boundaries

Two things belong to the person, not the agent: **the wallet PIN** and **tapping Accept/Share**.
Do not enter or tap them on someone's behalf; ask, and wait. Everything else below is fair game.

## 1. Make Heka reachable from the device — once per network

Heka advertises `http://localhost:3003`; on the device that is the device. Advertise the host's
LAN address instead:

```bash
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | ? { \$_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Docker' -and \$_.IPAddress -notlike '127.*' } | select InterfaceAlias,IPAddress"
cd ../../heka-identity-service
AGENT_OID4VCI_EP=http://<LAN-IP>:3003 docker compose -f docker-compose.dev.yml up -d heka-identity-service
```

`up -d` re-creates only the service container; never `down` (it wipes Postgres). No re-seed:
offers and requests are minted on demand and carry the new address. The LAN address changes with
the network — repeat after switching Wi-Fi.

Emulator-only fallback: leave Heka alone and `adb reverse tcp:3003 tcp:3003` +
`adb reverse tcp:3000 tcp:3000` after every emulator restart.

## 2. Emulator

```bash
emulator -avd <name> -memory 2048 -no-snapshot -no-boot-anim -netdelay none -netspeed full &
```

2 GB is enough. Budget 3–4 GB of host RAM for the emulator process; stop what the current step
does not need. `emulator` lives in `$LOCALAPPDATA/Android/Sdk/emulator` and is not on `PATH`.

## 3. The app

A dev build loads JS from Metro, so start that first (`yarn start` in `heka-wallet/app`), then
open the app on the device. If it is not installed, `yarn run:android` from `heka-wallet/app`
installs and launches it.

**Dismiss the 16 KB compatibility dialog** — the native libraries are not 16 KB aligned, Android
runs the app in compatibility mode, and it is harmless. Tap `Don't Show Again` or it returns every
launch.

Then the app asks for the PIN. That is the person's.

### Building it on Windows

Only if the app is not installed. Three traps, all encountered:

- **JDK 17.** Android Studio ships a newer JBR; Gradle rejects it with
  `Unsupported class file major version`. Set `JAVA_HOME` to a 17 install.
- **Short path.** Native C++ modules exceed the Windows path limit under a deep checkout —
  `ninja: error: manifest 'build.ninja' still dirty`. Build from a copy at something like `C:\hw`.
  A junction does not help: React Native resolves it back to the real path.
- **Node 20/22.** RN 0.81 rejects Node 24.

## 4. Link the wallet

After the PIN the wallet logs `Public DID: did:peer:2…`. RN 0.81 does not echo JS logs in the
Metro terminal — open React Native DevTools (`j` in Metro) or read the device log:

```bash
adb logcat -d -s ReactNativeJS | grep -o "Public DID: did:peer:[^ \"]*" | tail -1
```

Paste it into the **wallet** field in the header of the Trust Lens (`http://localhost:4000`) or the
Console (`http://localhost:4100`) and press **Link wallet**. Or:

```bash
curl -s -X POST http://localhost:4000/api/wallet/link -H 'content-type: application/json' \
  -d '{"holderDid":"did:peer:2…"}'
```

The link is written to `.wallet-link.json` and shared by both processes. A reinstalled or reset
wallet has a new DID — link again. `no did-communication service` means the value is not a wallet
DID.

## 5. Getting the credential into the wallet

Console → Finance Data Officer tile → **Send offer to wallet** (or
`curl -s -X POST http://localhost:4100/api/credentials/officer/offer`). The wallet, in the
foreground, shows a Credential Offer screen — **the person taps Accept** (scroll down; it sits
below Decline). Without a linked wallet the same button reads **Mint offer (QR)** and the
console shows the offer as a QR for a phone with a camera.

Every press mints a fresh single-use offer, so after `yarn seed --reset` or a wallet reset, just
press again.

Verify it landed: the Credentials tab should list `urn:heka:role-credential:v1`.

## 6. Presenting

Same mechanism for both protocol paths — only the verifier differs.

**A2A.** Engage the verified agent; when the panel says _Authorization required_, press
**Send to wallet**. Without the UI:

```bash
curl -s -X POST http://localhost:4000/api/task/<id>/send-to-wallet     # once state is auth-required
```

**MCP.** Ask the chat to export the suppliers' bank details, press **Send to wallet** in the paused step, or
`curl -s -X POST http://localhost:4000/api/mcp/send-to-wallet`.

Either way the wallet shows a Proof Request listing `role` and `org` — **the person taps Share**.

### The window is short

The verification session expires after Credo's default window and Heka does not expose
`expirationInSeconds` to lengthen it. A slow tap fails with:

```
Error while accepting authorization request. {"error":"invalid_request","error_description":"session expired"}
```

So: have the wallet unlocked and in the foreground _before_ pressing Send, tell the person to tap
immediately, and do not interleave screen dumps or scrolling. If it expires, **Resend to wallet**
(same session) or engage again — nothing is corrupted.

## 7. Confirming it was really the wallet

Do not take completion as proof; the simulated holder produces the same task outcome. Check both
sides:

- the Trust Lens / Console log: `[wallet-link] delivered …`, and the Audit tab entry
  _authorization request delivered to the operator's wallet_;
- the wallet's log (React Native DevTools, or `adb logcat -d -s ReactNativeJS`): the wallet
  resolving and verifying the request;
- the agent's terminal: `session … -> RequestUriRetrieved` (the wallet fetched the request) before
  `ResponseVerified`.

Together that is evidence rather than inference.

## Reading the screen without touching it

The wallet's log (DevTools / logcat) says what screen it is on. If you must look at the device,
`adb exec-out screencap` returns a black frame on a GPU emulator; use the accessibility tree:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
```

That is diagnostics, not the flow. A modal `Process system isn't responding` means the emulator is
starved of RAM.
