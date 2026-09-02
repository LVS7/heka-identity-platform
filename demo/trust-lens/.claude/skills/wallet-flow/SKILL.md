---
name: wallet-flow
description: Use when the demo needs the real Heka Wallet - starting the Android emulator, building or launching the app, loading the Finance Data Officer credential, and presenting it to the agent or the authorization server. Covers the Windows build traps and the short presentation window.
---

# Driving the real wallet

The demo runs without a wallet (the in-process holder presents instead), and that is the right
choice for development. Use a real wallet when human-in-the-loop is the thing being shown —
because who presented a credential is the subject of this demo, and a simulation cannot make that
point.

## Boundaries

Two things belong to the person, not the agent: **the wallet PIN** and **tapping Accept/Share**.
Do not enter or tap them on someone's behalf; ask, and wait. Everything else below is fair game.

## 1. Emulator

```bash
emulator -avd <name> -memory 2048 -no-snapshot -no-boot-anim -netdelay none -netspeed full &
adb wait-for-device
adb shell getprop sys.boot_completed   # 1 when ready
```

2 GB is enough. Budget 3–4 GB of host RAM for the emulator process; stop what the current step
does not need.

## 2. Port reverses — required, and they do not survive a restart

```bash
adb reverse tcp:3003 tcp:3003   # OID4VC — the wallet cannot work without this
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081   # Metro, for a dev build
```

Re-run after every emulator restart.

## 3. The app

If already installed (`adb shell pm list packages | grep heka`), just launch it:

```bash
adb shell monkey -p com.heka.wallet -c android.intent.category.LAUNCHER 1
```

A dev build loads JS from Metro, so start that first (`yarn start` in `heka-wallet/app`).

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

## 4. Getting the credential into the wallet

`yarn seed` prints a credential offer. On an emulator, deep-link it rather than pointing the
camera at a QR:

```bash
adb shell am start -a android.intent.action.VIEW -d '<openid-credential-offer://…>' com.heka.wallet
```

The wallet shows a Credential Offer screen — **the person taps Accept** (scroll down; it sits
below Decline).

If `yarn seed --reset` has run since, the old credential is stale: mint a fresh offer against the
current issuer and repeat.

Verify it landed: the Credentials tab should list `urn:heka:role-credential:v1`.

## 5. Presenting

Same mechanism for both protocol paths — only the verifier differs.

**A2A.** Start a task, poll until `auth-required`, take `authorizationRequest`, deep-link it:

```bash
adb shell am start -a android.intent.action.VIEW -d '<openid4vp://…>' com.heka.wallet
```

**MCP.** Call the sensitive tool, take `authorization.request` from the response, deep-link the
same way.

Either way the wallet shows a Proof Request listing `role` and `org` — **the person taps Share**.

### The window is short

The verification session expires after Credo's default window and Heka does not expose
`expirationInSeconds` to lengthen it. A slow tap fails with:

```
Error while accepting authorization request. {"error":"invalid_request","error_description":"session expired"}
```

So: create the request and deep-link it in **one step**, tell the person to tap immediately, and
do not interleave screen dumps or scrolling. If it expires, just repeat — nothing is corrupted.

## 6. Confirming it was really the wallet

Do not take completion as proof; the simulated holder produces the same task outcome. Check both
sides:

```bash
adb logcat -d | grep -i "verified Authorization Request"     # the wallet resolved and verified it
docker logs trustlens-agent | grep -E "RequestUriRetrieved|ResponseVerified"
```

`RequestUriRetrieved` is the moment the wallet fetched the request. Together with the wallet's own
log, that is evidence rather than inference.

## Reading the screen

`adb exec-out screencap` returns a black frame on a GPU emulator. Use the accessibility tree
instead:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
```

It gives text, content-desc and bounds — enough to find a button and to know what the screen says.
Taps via `adb shell input tap` are unreliable on a loaded emulator; prefer asking the person, and
note that a modal (`Process system isn't responding`) usually means the emulator is starved of RAM.
