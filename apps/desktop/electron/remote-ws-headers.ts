import { remoteRequestMatchesBaseUrl } from './connection-config'
import { withEmbedRefererStamp } from './embed-referer'
import { registryGatewayWsUrl } from './plugin-profile-routes'

export interface RegistryGatewayWsConnection {
  authMode: string
  baseUrl: string
  wsUrl: string
  headers?: Record<string, string>
  profile?: null | string
  sharedRemote?: boolean
}

interface RegistryGatewayWsUrlDependencies {
  ensureBackend: (connectionId: unknown, profile: unknown) => Promise<RegistryGatewayWsConnection>
  mintTicket: (baseUrl: string, headers?: Record<string, string>) => Promise<string>
  buildTicketUrl: (baseUrl: string, ticket: string) => string
  rememberHeaders: (wsUrl: string, headers?: Record<string, string>) => void
}

interface RemoteRequestDetails {
  url: string
  requestHeaders?: Record<string, string>
}

type RemoteRequestCallback = (result: { requestHeaders?: Record<string, string> }) => void

export interface RemoteHeaderSource {
  headers?: Record<string, string>
  kind?: string
  url?: string
}

interface SessionLike {
  webRequest?: {
    onBeforeSendHeaders?: (listener: (details: RemoteRequestDetails, callback: RemoteRequestCallback) => void) => void
  }
}

/**
 * Header blocks that Chromium (login window, renderer WS) may attach to a
 * remote gateway request. Registry Connections are the live source; the v1
 * single-remote block is fallback. Longer base URLs win so a path-prefixed
 * gateway is not shadowed by its origin sibling.
 *
 * Values arrive already sanitized: decryptRemoteHeaders in main.ts strips
 * CR/LF on the single decrypt funnel, so there is no second normalizer here.
 */
export function collectRemoteHeaderSources(input: {
  connections?: RemoteHeaderSource[]
  v1Remote?: null | RemoteHeaderSource
}): RemoteHeaderSource[] {
  const sources: RemoteHeaderSource[] = []

  for (const connection of input.connections || []) {
    if (connection.kind && connection.kind !== 'remote' && connection.kind !== 'cloud') {
      continue
    }

    if (!connection.url || !connection.headers || Object.keys(connection.headers).length === 0) {
      continue
    }

    sources.push({ headers: connection.headers, url: connection.url })
  }

  if (input.v1Remote?.url && input.v1Remote.headers && Object.keys(input.v1Remote.headers).length > 0) {
    sources.push({
      headers: input.v1Remote.headers,
      url: input.v1Remote.url
    })
  }

  return sources.sort((a, b) => String(b.url || '').length - String(a.url || '').length)
}

export function resolveRemoteRequestHeaders(
  requestUrl: string,
  options: { exactHeaders?: Record<string, string>; sources?: RemoteHeaderSource[] } = {}
): Record<string, string> {
  const exact = options.exactHeaders || {}

  if (Object.keys(exact).length > 0) {
    return exact
  }

  for (const source of options.sources || []) {
    if (!source.url || !source.headers) {
      continue
    }

    if (Object.keys(source.headers).length > 0 && remoteRequestMatchesBaseUrl(requestUrl, source.url)) {
      return source.headers
    }
  }

  return {}
}

export function formatLoadUrlExtraHeaders(headers: Record<string, string> = {}): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

export function oauthLoginLoadUrlOptions(headers: Record<string, string> = {}): { extraHeaders?: string } {
  const extraHeaders = formatLoadUrlExtraHeaders(headers)

  return extraHeaders ? { extraHeaders } : {}
}

export function attachRemoteRequestHeaderListener(
  sessionLike: SessionLike,
  headersForRequest: (requestUrl: string) => Record<string, string>,
  rendererOrigin: () => string | undefined = () => undefined
) {
  // The YouTube embed Referer stamp composes onto this same listener: Electron
  // allows a single onBeforeSendHeaders listener per session, so the default
  // session (where chat embeds' iframes live) gets both behaviors here.
  sessionLike?.webRequest?.onBeforeSendHeaders?.(
    withEmbedRefererStamp((details, callback) => {
      applyRemoteRequestHeaders(details, callback, headersForRequest, rendererOrigin())
    })
  )
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The packaged renderer used to load from file://, so every gateway WebSocket
 * it dialed carried `Origin: file://`. It now loads from a loopback HTTP origin
 * (for YouTube embeds), which a remote backend's Host/Origin guard rejects with
 * 4403 unless it is new enough to trust loopback origins. Send remote
 * WebSocket upgrades from the renderer the Origin it always sent, so a Desktop
 * update never strands a backend that has not been updated yet.
 */
export function withLegacyRendererOrigin(
  requestUrl: string,
  headers: Record<string, string>,
  rendererOrigin?: string
): Record<string, string> {
  if (!rendererOrigin) {
    return headers
  }

  let target: URL

  try {
    target = new URL(requestUrl)
  } catch {
    return headers
  }

  if ((target.protocol !== 'ws:' && target.protocol !== 'wss:') || LOOPBACK_HOSTNAMES.has(target.hostname)) {
    return headers
  }

  const originKey = Object.keys(headers).find(name => name.toLowerCase() === 'origin')

  if (!originKey || headers[originKey] !== rendererOrigin) {
    return headers
  }

  return { ...headers, [originKey]: 'file://' }
}

export function createRemoteWsHeaderStore(limit = 100) {
  const headersByUrl = new Map<string, Record<string, string>>()

  const remember = (wsUrl: string, headers: Record<string, string> = {}) => {
    if (!wsUrl || Object.keys(headers).length === 0) {
      return
    }

    headersByUrl.set(String(wsUrl), headers)

    while (headersByUrl.size > limit) {
      const oldest = headersByUrl.keys().next().value

      if (!oldest) {
        break
      }

      headersByUrl.delete(oldest)
    }
  }

  const headersFor = (requestUrl: string): Record<string, string> => {
    const key = String(requestUrl)
    const headers = headersByUrl.get(key)

    if (!headers) {
      return {}
    }

    headersByUrl.delete(key)
    headersByUrl.set(key, headers)

    return headers
  }

  return { headersFor, remember }
}

export function applyRemoteRequestHeaders(
  details: RemoteRequestDetails,
  callback: RemoteRequestCallback,
  headersForRequest: (requestUrl: string) => Record<string, string>,
  rendererOrigin?: string
) {
  const headers = headersForRequest(details.url)
  const base = details.requestHeaders ?? {}
  const merged = Object.keys(headers).length > 0 ? { ...base, ...headers } : base
  const requestHeaders = withLegacyRendererOrigin(details.url, merged, rendererOrigin)

  // An empty result means "no changes"; requestHeaders replaces every header.
  callback(requestHeaders === base ? {} : { requestHeaders })
}

export function createRegistryGatewayWsUrlHandler(dependencies: RegistryGatewayWsUrlDependencies) {
  return async (payload: unknown): Promise<string> => {
    const { connectionId, profile } = payload && typeof payload === 'object' ? (payload as any) : ({} as any)
    const connection = await dependencies.ensureBackend(connectionId, profile)
    let wsUrl = connection.wsUrl

    if (connection.authMode === 'oauth') {
      const ticket = await dependencies.mintTicket(connection.baseUrl, connection.headers)
      wsUrl = dependencies.buildTicketUrl(connection.baseUrl, ticket)
    }

    const finalWsUrl = registryGatewayWsUrl(connection, wsUrl)

    dependencies.rememberHeaders(finalWsUrl, connection.headers)

    return finalWsUrl
  }
}
