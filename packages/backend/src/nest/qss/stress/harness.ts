/**
 * Boots a Nest test module with the QSS path wired against a real QSS server
 * (front of which a Toxiproxy listener allows network fault injection per scenario).
 *
 * Mirrors the module graph used by qss.service.spec.ts but overrides
 * QSS_ALLOWED/QSS_ENDPOINT so the QSSService talks through the proxy, and
 * leaves the full graph (sigchain, identity, current community) primed for
 * connect / signIn flows.
 */
import { Test, TestingModule } from '@nestjs/testing'
import * as fs from 'node:fs'
import * as net from 'node:net'

import { TestModule } from '../../common/test.module'
import { QSSModule } from '../qss.module'
import { QSSService } from '../qss.service'
import { QSSClient } from '../qss.client'
import { QSSAuthConnectionManager } from '../qss-auth-conn-manager.service'
import { QSS_ALLOWED, QSS_ENDPOINT } from '../../const'
import { SigChainModule } from '../../auth/sigchain.service.module'
import { SigChainService } from '../../auth/sigchain.service'
import { OrbitDbService } from '../../storage/orbitDb/orbitDb.service'
import { OrbitDbModule } from '../../storage/orbitDb/orbitdb.module'
import { Libp2pService } from '../../libp2p/libp2p.service'
import { IpfsService } from '../../ipfs/ipfs.service'
import { IpfsModule } from '../../ipfs/ipfs.module'
import { IpfsFileManagerModule } from '../../ipfs-file-manager/ipfs-file-manager.module'
import { LocalDbService } from '../../local-db/local-db.service'
import { CaptchaService } from '../../captcha/captcha.service'
import { spawnLibp2pInstancesInMemory } from '../../common/test-utils'
import { ToxiproxyClient } from './toxiproxy'
import { Community, CommunityOwnership, Identity, InvitationDataVersion } from '@quiet/types'
import { getReduxStoreFactory, prepareStore, Store } from '@quiet/state-manager'
import { FactoryGirl } from 'factory-girl'

export interface HarnessOptions {
  /** URL the QSSService will see for QSS — typically the toxiproxy listener.
   *  If omitted, a fresh proxy is allocated on a free local port and that URL is used. */
  qssEndpoint?: string
  /** Toxiproxy admin URL (defaults to http://127.0.0.1:8474). */
  toxiproxyAdmin?: string
  /** Name of the proxy to create at the admin API. Auto-generated if omitted. */
  proxyName?: string
  /** Where the proxy listens (host:port form). Auto-allocated if omitted. */
  proxyListen?: string
  /** Upstream — where the QSS server actually runs (host:port). */
  proxyUpstream?: string
  /** Username for the test identity. */
  username?: string
  /** Team name. */
  teamName?: string
  /** Skip libp2p in-memory bootstrap. Default true; QSS-only flows don't need libp2p. */
  skipLibp2p?: boolean
  /** Skip OrbitDb.create. Default true; only required for tests that write/read orbitdb log entries. */
  skipOrbitDbCreate?: boolean
}

export interface QssHarness {
  module: TestingModule
  qssService: QSSService
  qssClient: QSSClient
  qssAuthConnManager: QSSAuthConnectionManager
  sigchainService: SigChainService
  orbitDbService: OrbitDbService
  ipfsService: IpfsService
  libp2pService: Libp2pService
  localDbService: LocalDbService
  captchaService: CaptchaService
  store: Store
  factory: FactoryGirl
  toxiproxy: ToxiproxyClient
  proxyName: string
  proxyListen: string
  qssEndpoint: string
  community: Community
  identity: Identity
  /**
   * Pre-stuffs the renderer-side captcha token. After this call, the next
   * captcha-required QSS operation runs end-to-end over the wire — the real
   * `GET_CAPTCHA_SITE_KEY` and `VERIFY_CAPTCHA` round-trips happen, and QSS
   * really validates against hCaptcha (the dev secret accepts the test token).
   */
  primeCaptcha: () => void
  shutdown: () => Promise<void>
}

/**
 * Official hCaptcha test response token. Always validates as success against
 * the test site/secret key pair that QSS runs in dev.
 * https://docs.hcaptcha.com/#integration-testing-test-keys
 */
export const HCAPTCHA_TEST_TOKEN = '10000000-aaaa-bbbb-cccc-000000000001'

export interface OwnerInvite {
  inviteId: string
  seed: string
  salt: string
  teamId: string
  teamName: string
}

/**
 * Generate a long-lived invite from an owner harness whose community is
 * already created on QSS. The returned shape feeds bootMemberHarness.
 *
 * Also writes the invite lockbox onto the owner's chain so the member's
 * later self-assign-MEMBER call has team-side role keys to derive against.
 * Without this the LFA assertion `keysAllGenerations` fires when the member
 * tries to self-assign.
 */
export function generateOwnerInvite(owner: QssHarness): OwnerInvite {
  const sigchain = owner.sigchainService.activeChain
  if (sigchain.team == null) {
    throw new Error('Owner sigchain has no team — call after createCommunity completes')
  }
  const invite = sigchain.invites.createLongLivedUserInvite()
  sigchain.lockbox.createInviteLockboxes(invite.seed, invite.salt)
  return {
    inviteId: invite.id,
    seed: invite.seed,
    salt: invite.salt,
    teamId: sigchain.team.id,
    teamName: sigchain.team.teamName,
  }
}

export interface MemberHarnessOptions {
  /** Invite produced by `generateOwnerInvite(owner)` after the owner created the community. */
  invite: OwnerInvite
  /** Username for the joining member. Must differ from owner's. */
  username: string
  /** Endpoint and proxy options inherit DEFAULTS unless overridden. */
  qssEndpoint?: string
  toxiproxyAdmin?: string
  proxyName?: string
  proxyListen?: string
  proxyUpstream?: string
}

export const DEFAULTS = {
  toxiproxyAdmin: process.env.TOXIPROXY_ADMIN ?? 'http://127.0.0.1:8474',
  proxyUpstream: process.env.QSS_STRESS_UPSTREAM ?? '127.0.0.1:3003',
  username: 'stress-user',
  teamName: 'stress-community',
}

/** Find a free TCP port by binding to 0 and reading what the OS gave us. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr != null ? addr.port : 0
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

let proxyCounter = 0
const proxyId = (): string => {
  const pid = process.pid
  const wid = process.env.JEST_WORKER_ID ?? '0'
  const n = ++proxyCounter
  return `qss-${pid}-${wid}-${n}`
}

export async function bootQssHarness(opts: HarnessOptions = {}): Promise<QssHarness> {
  const proxyUpstream = opts.proxyUpstream ?? DEFAULTS.proxyUpstream
  const toxiproxyAdmin = opts.toxiproxyAdmin ?? DEFAULTS.toxiproxyAdmin
  const username = opts.username ?? DEFAULTS.username
  const teamName = opts.teamName ?? DEFAULTS.teamName
  // libp2p stays on by default — IPFS/Helia depends on it and crashes its
  // create() without an initialised libp2p instance. Keep the option for
  // future refactors where IPFS could be disabled too.
  const skipLibp2p = opts.skipLibp2p ?? false
  const skipOrbitDbCreate = opts.skipOrbitDbCreate ?? true

  // Allocate a fresh per-harness toxiproxy proxy (unique name + free port)
  // so multiple harnesses can run in parallel under jest --maxWorkers=N.
  const proxyName = opts.proxyName ?? proxyId()
  const proxyPort = opts.proxyListen != null ? Number(opts.proxyListen.split(':')[1]) : await pickFreePort()
  const proxyListen = opts.proxyListen ?? `127.0.0.1:${proxyPort}`
  const qssEndpoint = opts.qssEndpoint ?? `ws://127.0.0.1:${proxyPort}`

  const adminUrl = new URL(toxiproxyAdmin)
  const toxiproxy = new ToxiproxyClient(adminUrl.hostname, Number(adminUrl.port || 8474))
  await toxiproxy.ping()
  await toxiproxy.ensureProxy({
    name: proxyName,
    listen: proxyListen,
    upstream: proxyUpstream,
    enabled: true,
  })
  await toxiproxy.clearToxics(proxyName)

  const store = prepareStore().store
  const factory = await getReduxStoreFactory(store)

  const module = await Test.createTestingModule({
    imports: [TestModule, SigChainModule, IpfsFileManagerModule, IpfsModule, OrbitDbModule, QSSModule],
  })
    .overrideProvider(QSS_ALLOWED)
    .useValue(true)
    .overrideProvider(QSS_ENDPOINT)
    .useValue(qssEndpoint)
    .compile()

  const qssService = module.get<QSSService>(QSSService)
  const qssClient = module.get<QSSClient>(QSSClient)
  const qssAuthConnManager = module.get<QSSAuthConnectionManager>(QSSAuthConnectionManager)
  const sigchainService = module.get<SigChainService>(SigChainService)
  const captchaService = module.get<CaptchaService>(CaptchaService)
  const libp2pService = await module.resolve(Libp2pService)
  if (!skipLibp2p) {
    await spawnLibp2pInstancesInMemory([module])
  }
  const ipfsService = await module.resolve(IpfsService)
  await ipfsService.createInstance()
  const localDbService = await module.resolve(LocalDbService)

  const community: Community = await factory.create('Community', { name: teamName })
  const identity: Identity = await factory.create('Identity', { communityId: community.id, nickname: username })
  // Sigchain must be active before OrbitDb.create, because the LFA identity
  // provider derives the orbitdb identity from the active sigchain.
  await sigchainService.createChain(community.name!, username, true)

  const orbitDbService = await module.resolve(OrbitDbService)
  if (!skipOrbitDbCreate) {
    await orbitDbService.create(ipfsService.ipfsInstance!)
  }

  await localDbService.setCommunity({ ...community, qssEnabled: true, qssSetup: false } as any)
  await localDbService.setCurrentCommunityId(community.id)
  await localDbService.setIdentity(identity)

  const shutdown = async (): Promise<void> => {
    await toxiproxy.clearToxics(proxyName).catch(() => undefined)
    // Delete the per-harness proxy so accumulated proxies don't pile up in
    // toxiproxy under long sweeps.
    await toxiproxy.deleteProxy(proxyName).catch(() => undefined)
    try {
      qssService.close()
    } catch {
      // ignore
    }
    if (!skipOrbitDbCreate) {
      await orbitDbService?.stop().catch(() => undefined)
      if (orbitDbService?.orbitDbDir != null && fs.existsSync(orbitDbService.orbitDbDir)) {
        try {
          fs.rmSync(orbitDbService.orbitDbDir, { recursive: true })
        } catch {
          // ignore
        }
      }
    }
    await ipfsService?.stop().catch(() => undefined)
    if (!skipLibp2p) {
      await libp2pService?.close(true).catch(() => undefined)
    }
    await localDbService?.close().catch(() => undefined)
    await module?.close().catch(() => undefined)
  }

  const primeCaptcha = (): void => {
    captchaService.hcaptchaToken = HCAPTCHA_TEST_TOKEN
  }

  return {
    module,
    qssService,
    qssClient,
    qssAuthConnManager,
    sigchainService,
    orbitDbService,
    ipfsService,
    libp2pService,
    localDbService,
    captchaService,
    store,
    factory,
    toxiproxy,
    proxyName,
    proxyListen,
    qssEndpoint,
    community: (await localDbService.getCurrentCommunity())!,
    identity,
    primeCaptcha,
    shutdown,
  }
}

/**
 * Boots a member harness — same Nest module graph as the owner, but with a
 * sigchain primed from the owner's invite seed and a localDb community whose
 * `inviteData` carries the teamId. The QSSService's auto-flow takes the
 * `signInToCommunity` branch (since `sigChain.team == null`), drives the
 * AUTH_SYNC handshake through QSS, and converges to JoinStatus.JOINED once
 * the owner-side LFA accepts the join.
 *
 * The owner harness must be running and its auth connection active when the
 * member is booted, otherwise the AUTH_SYNC routing has no peer.
 */
export async function bootMemberHarness(opts: MemberHarnessOptions & {
  /** Skip libp2p in-memory bootstrap. Default true. */
  skipLibp2p?: boolean
}): Promise<QssHarness> {
  const proxyUpstream = opts.proxyUpstream ?? DEFAULTS.proxyUpstream
  const toxiproxyAdmin = opts.toxiproxyAdmin ?? DEFAULTS.toxiproxyAdmin
  const username = opts.username
  const skipLibp2p = opts.skipLibp2p ?? false

  // Multi-client scenarios pass the owner's proxy details so both clients
  // share network conditions. If only proxyName is given, derive listen from
  // toxiproxy admin lookup; if proxyListen is given, use it directly.
  const proxyName = opts.proxyName ?? proxyId()
  const proxyPort = opts.proxyListen != null ? Number(opts.proxyListen.split(':')[1]) : await pickFreePort()
  const proxyListen = opts.proxyListen ?? `127.0.0.1:${proxyPort}`
  const qssEndpoint = opts.qssEndpoint ?? `ws://127.0.0.1:${proxyPort}`

  const adminUrl = new URL(toxiproxyAdmin)
  const toxiproxy = new ToxiproxyClient(adminUrl.hostname, Number(adminUrl.port || 8474))
  await toxiproxy.ping()
  await toxiproxy.ensureProxy({
    name: proxyName,
    listen: proxyListen,
    upstream: proxyUpstream,
    enabled: true,
  })

  const store = prepareStore().store
  const factory = await getReduxStoreFactory(store)

  const module = await Test.createTestingModule({
    imports: [TestModule, SigChainModule, IpfsFileManagerModule, IpfsModule, OrbitDbModule, QSSModule],
  })
    .overrideProvider(QSS_ALLOWED)
    .useValue(true)
    .overrideProvider(QSS_ENDPOINT)
    .useValue(qssEndpoint)
    .compile()

  const qssService = module.get<QSSService>(QSSService)
  const qssClient = module.get<QSSClient>(QSSClient)
  const qssAuthConnManager = module.get<QSSAuthConnectionManager>(QSSAuthConnectionManager)
  const sigchainService = module.get<SigChainService>(SigChainService)
  const captchaService = module.get<CaptchaService>(CaptchaService)
  const libp2pService = await module.resolve(Libp2pService)
  if (!skipLibp2p) {
    await spawnLibp2pInstancesInMemory([module])
  }
  const ipfsService = await module.resolve(IpfsService)
  await ipfsService.createInstance()
  const localDbService = await module.resolve(LocalDbService)

  // Member's sigchain is built from the invite seed — no team yet. The team
  // arrives via the AUTH_SYNC `joined` event during the QSS-routed handshake.
  await sigchainService.createChainFromInvite(
    username,
    opts.invite.teamName,
    opts.invite.seed,
    opts.invite.teamId,
    true
  )

  // OrbitDB is intentionally NOT initialised here. Its LFA identity provider
  // reads `sigchain.team!.id` during construction, which throws while the
  // member is pre-join (no team yet). Production defers OrbitDB init until
  // after the auth handshake completes; we mirror that.
  const orbitDbService = await module.resolve(OrbitDbService)

  // Build a Community record carrying the invite data the QSS_HANDLE_SIGN_IN
  // handler needs to extract teamId for `signInToCommunity`. qssSetup is left
  // false; on this branch the handler reads teamId from inviteData regardless.
  const community: Community = await factory.create('Community', { name: opts.invite.teamName })
  const identity: Identity = await factory.create('Identity', {
    communityId: community.id,
    nickname: username,
  })
  const inviteData = {
    version: InvitationDataVersion.v3,
    pairs: [],
    psk: 'no-libp2p-in-this-harness',
    qssEnabled: true,
    qssEndpoint,
    authData: {
      communityName: opts.invite.teamName,
      seed: opts.invite.seed,
      teamId: opts.invite.teamId,
      salt: opts.invite.salt,
    },
  }
  await localDbService.setCommunity({
    ...community,
    name: opts.invite.teamName,
    qssEnabled: true,
    qssSetup: false,
    inviteData,
  } as Community)
  await localDbService.setCurrentCommunityId(community.id)
  await localDbService.setIdentity(identity)

  const primeCaptcha = (): void => {
    captchaService.hcaptchaToken = HCAPTCHA_TEST_TOKEN
  }

  const shutdown = async (): Promise<void> => {
    // For member harnesses: only delete the proxy if we created it
    // (i.e., it was not passed in by the caller).
    if (opts.proxyName == null) {
      await toxiproxy.clearToxics(proxyName).catch(() => undefined)
      await toxiproxy.deleteProxy(proxyName).catch(() => undefined)
    }
    try {
      qssService.close()
    } catch {
      // ignore
    }
    await ipfsService?.stop().catch(() => undefined)
    if (!skipLibp2p) {
      await libp2pService?.close(true).catch(() => undefined)
    }
    await localDbService?.close().catch(() => undefined)
    await module?.close().catch(() => undefined)
  }

  return {
    module,
    qssService,
    qssClient,
    qssAuthConnManager,
    sigchainService,
    orbitDbService,
    ipfsService,
    libp2pService,
    localDbService,
    captchaService,
    store,
    factory,
    toxiproxy,
    proxyName,
    proxyListen,
    qssEndpoint,
    community: (await localDbService.getCurrentCommunity())!,
    identity,
    primeCaptcha,
    shutdown,
  }
}
