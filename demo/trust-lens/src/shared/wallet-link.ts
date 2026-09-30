/**
 * Delivering things to the operator's Heka Wallet over DIDComm.
 *
 * The demo's authorization step needs an OID4VP request (and, once, a credential offer) to reach
 * the phone. A QR works with a camera; an emulator has none, and driving it with `adb` is a shell
 * trick rather than a protocol. The reference demo (`demo/a2a-oid4vp/src/cli.ts`) shows the
 * protocol way: a DIDComm *basic message* whose content is the URI, sent to the wallet's public
 * `did:peer:2`. Heka Wallet hands the content of any inbound basic message to the same handler a
 * scanned QR goes through, so the Proof Request (or Credential Offer) screen simply appears.
 *
 * Two things are deliberately unusual and copied from the reference:
 *
 * - The connection is *forged*, not negotiated. The wallet on Credo 0.7 does not yet run DID
 *   Exchange with this demo, so instead of an out-of-band invitation we save a connection record
 *   already in state `Completed` with `theirDid` set to the wallet's public DID. The wallet side
 *   carries a patch that accepts basic messages from unknown connections.
 * - The wallet never answers us. It posts the presentation straight to Heka; the relying party
 *   learns the outcome from Heka. So delivery is fire-and-forget, and an inbound transport is not
 *   strictly needed: a `did:key` sender has no endpoint, and Credo then marks the message
 *   `return_route: all` by itself. The inbound HTTP transport is kept to mirror the proven
 *   reference configuration; it can be dropped once the DIDComm path has been exercised end to end.
 *
 * Credo 0.7 only delivers to `did-communication` / `IndyAgent` services and silently drops the
 * DIDComm v2 `DIDCommMessaging` type, which fails much later as an opaque "undeliverable". The
 * wallet's DID is built from its mediator routing and has the right type; `link()` checks anyway,
 * so a wrong DID pasted into the UI fails at link time with a reason.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** What the link needs from a DIDComm stack — narrow on purpose so the logic is testable offline. */
export interface WalletLinkTransport {
  initialize(): Promise<void>
  /** Service types found in the DID document (e.g. `did-communication`). */
  resolveServiceTypes(did: string): Promise<string[]>
  /** Create (or replace) the connection to `theirDid`; returns the connection id. */
  connect(theirDid: string): Promise<string>
  send(connectionId: string, content: string): Promise<void>
  shutdown(): Promise<void>
}

export interface WalletLinkStatus {
  linked: boolean
  holderDid?: string
  linkedAt?: string
  /** Where the DID came from: the persisted link file, or `HOLDER_PUBLIC_DID` in the env. */
  source?: 'file' | 'env'
}

interface PersistedLink {
  holderDid: string
  linkedAt: string
}

/**
 * Where the link lives. Next to `.seed-state.json`, and shared by the Trust Lens and the TrustCo
 * Console: the DID outlives any one process, and pasting it twice would be silly.
 */
export const WALLET_LINK_FILE = resolve(process.cwd(), '.wallet-link.json')

/** Service types Credo 0.7's DIDComm v1 sender can deliver to. */
const DELIVERABLE_SERVICE_TYPES = ['did-communication', 'IndyAgent']

export function isHolderDid(value: string): boolean {
  return /^did:peer:\S+$/.test(value)
}

export class WalletLink {
  private readonly stateFile: string
  private readonly makeTransport: () => WalletLinkTransport
  private readonly log: (message: string) => void

  private current: PersistedLink | undefined
  private source: 'file' | 'env' | undefined
  private transport: WalletLinkTransport | undefined
  private connectionId: string | undefined
  private connectedTo: string | undefined

  public constructor(options: {
    stateFile: string
    initialDid?: string
    transport: () => WalletLinkTransport
    log?: (message: string) => void
  }) {
    this.stateFile = options.stateFile
    this.makeTransport = options.transport
    this.log = options.log ?? ((message) => console.log(`[wallet-link] ${message}`))

    const persisted = this.readFile()
    if (persisted) {
      this.current = persisted
      this.source = 'file'
    } else if (options.initialDid && isHolderDid(options.initialDid)) {
      this.current = { holderDid: options.initialDid, linkedAt: new Date().toISOString() }
      this.source = 'env'
    }
  }

  public get status(): WalletLinkStatus {
    this.refresh()
    if (!this.current) return { linked: false }
    return { linked: true, holderDid: this.current.holderDid, linkedAt: this.current.linkedAt, source: this.source }
  }

  /** Validate, check deliverability, forge the connection, persist. */
  public async link(holderDid: string): Promise<WalletLinkStatus> {
    if (!isHolderDid(holderDid)) {
      throw new Error('the wallet DID must be a did:peer (the "Public DID" the wallet logs at startup)')
    }

    await this.connect(holderDid)

    this.current = { holderDid, linkedAt: new Date().toISOString() }
    this.source = 'file'
    writeFileSync(this.stateFile, `${JSON.stringify(this.current, null, 2)}\n`)
    this.log(`linked to ${holderDid}`)
    return this.status
  }

  public async unlink(): Promise<void> {
    this.current = undefined
    this.source = undefined
    this.connectionId = undefined
    this.connectedTo = undefined
    if (existsSync(this.stateFile)) rmSync(this.stateFile)
    this.log('unlinked')
  }

  /** Deliver a URI (OID4VP request or credential offer) to the linked wallet. */
  public async send(content: string): Promise<void> {
    this.refresh()
    if (!this.current) throw new Error('no wallet linked — paste the wallet’s Public DID first')

    const connectionId = await this.connect(this.current.holderDid)
    await (this.transport as WalletLinkTransport).send(connectionId, content)
    this.log(`delivered ${content.slice(0, 40)}… to ${this.current.holderDid.slice(0, 24)}…`)
  }

  public async shutdown(): Promise<void> {
    await this.transport?.shutdown()
    this.transport = undefined
    this.connectionId = undefined
    this.connectedTo = undefined
  }

  private async connect(theirDid: string): Promise<string> {
    if (!this.transport) {
      this.transport = this.makeTransport()
      await this.transport.initialize()
    }
    if (this.connectionId && this.connectedTo === theirDid) return this.connectionId

    const serviceTypes = await this.transport.resolveServiceTypes(theirDid)
    if (!serviceTypes.some((type) => DELIVERABLE_SERVICE_TYPES.includes(type))) {
      throw new Error(
        `the wallet DID exposes no did-communication service (found: ${serviceTypes.join(', ') || 'none'}); ` +
          'Credo 0.7 cannot deliver to it'
      )
    }

    this.connectionId = await this.transport.connect(theirDid)
    this.connectedTo = theirDid
    return this.connectionId
  }

  /**
   * Another process (the console, or the web) may have written the file since we last looked.
   * The file is authoritative; the env value only ever seeds an absent file.
   */
  private refresh(): void {
    const persisted = this.readFile()
    if (persisted && persisted.holderDid !== this.current?.holderDid) {
      this.current = persisted
      this.source = 'file'
    } else if (persisted && this.source === 'env') {
      this.source = 'file'
    }
  }

  private readFile(): PersistedLink | undefined {
    if (!existsSync(this.stateFile)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedLink>
      if (parsed.holderDid && isHolderDid(parsed.holderDid)) {
        return { holderDid: parsed.holderDid, linkedAt: parsed.linkedAt ?? new Date().toISOString() }
      }
    } catch {
      // A corrupt link file is the same as no link file.
    }
    return undefined
  }
}
