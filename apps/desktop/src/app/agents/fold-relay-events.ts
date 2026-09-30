import type { RelayEvent, TraceDoc, TraceSpan, TraceSpanKind, TraceSpanStatus, TraceTurnSummary } from '@/store/trace'

// Scope names Hermes gives its own Relay scopes (agent/relay_runtime.py).
const SESSION_SCOPE = 'hermes.session'
const TURN_SCOPE = 'hermes.turn'
const LOGICAL_LLM_SCOPE = 'hermes.logical_llm_call'
const TURN_INPUT_MARK = 'hermes.turn.input'
const DELEGATE_TOOL = 'delegate_task'

export interface TraceLabels {
  llmCall: string
  session: string
  subagent: string
  turn: string
}

const KIND_BY_CATEGORY: Record<string, TraceSpanKind> = { agent: 'AGENT', llm: 'LLM', tool: 'TOOL' }

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export function relayEventSeconds(event: RelayEvent): number {
  const ms = Date.parse(event.timestamp)

  return Number.isFinite(ms) ? ms / 1000 : 0
}

function pretty(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function spanStatus(end: RelayEvent | undefined): TraceSpanStatus {
  if (!end) {
    return 'running'
  }

  const outcome = str(obj(end.data).outcome)

  if (obj(end.metadata)['otel.status_code'] === 'ERROR' || outcome === 'failed') {
    return 'error'
  }

  return outcome === 'cancelled' || obj(end.metadata)['hermes.status'] === 'abandoned' ? 'unset' : 'ok'
}

/** What the inspector shows: the model, tokens and payload Relay recorded for the span. */
function spanAttributes(start: RelayEvent, end: RelayEvent | undefined): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  const profile = { ...obj(start.category_profile), ...obj(end?.category_profile) }

  if (start.category === 'tool') {
    attributes['tool.name'] = start.name
    attributes['input.value'] = pretty(start.data)
    attributes['output.value'] = pretty(end?.data)

    return attributes
  }

  if (start.category === 'llm') {
    const request = obj(obj(start.data).content)
    const response = obj(end?.data)
    const annotated = obj(profile.annotated_response)
    const usage = { ...obj(response.usage), ...obj(annotated.usage) }
    const messages = Array.isArray(request.messages) ? request.messages : []
    const last = obj(messages.at(-1))

    attributes['llm.model_name'] = str(profile.model_name) || str(request.model)
    attributes['llm.token_count.prompt'] = num(usage.prompt_tokens) ?? num(usage.input_tokens)
    attributes['llm.token_count.completion'] = num(usage.completion_tokens) ?? num(usage.output_tokens)
    attributes['llm.token_count.reasoning'] = num(usage.reasoning_tokens)
    attributes['hermes.finish_reason'] = str(response.finish_reason) || str(annotated.finish_reason)
    attributes['input.value'] = pretty(last.content ?? request.messages)
    attributes['output.value'] = pretty(annotated.message ?? response.content ?? end?.data)

    return attributes
  }

  const metadata = obj(start.metadata)
  attributes['session.source'] = str(metadata['hermes.execution_surface'])

  return attributes
}

/**
 * Fold one session's Relay event log into the waterfall's span tree. A span is a
 * scope start/end pair (same uuid); an open scope is running and extends to `nowSec`.
 * A delegated session's scope hangs off the turn in Relay; it is drawn under the
 * `delegate_task` call that was open when it started, which is the call that spawned it.
 */
export function foldRelayEvents(events: RelayEvent[], labels: TraceLabels, nowSec: number): TraceDoc {
  const starts = new Map<string, RelayEvent>()
  const ends = new Map<string, RelayEvent>()
  const turnInputs = new Map<string, string>()

  for (const event of events) {
    if (event.kind === 'mark') {
      if (event.name === TURN_INPUT_MARK && event.parent_uuid) {
        turnInputs.set(event.parent_uuid, str(obj(event.data).preview))
      }
    } else if (event.scope_category === 'end') {
      ends.set(event.uuid, event)
    } else {
      starts.set(event.uuid, event)
    }
  }

  const spans: TraceSpan[] = []
  const sessionOf = new Map<string, null | string>()

  const owningSession = (uuid: null | string | undefined): null | string => {
    if (!uuid || !starts.has(uuid)) {
      return null
    }

    const cached = sessionOf.get(uuid)

    if (cached !== undefined) {
      return cached
    }

    const start = starts.get(uuid)!
    const own = start.name === SESSION_SCOPE ? str(obj(start.metadata)['hermes.session_id']) || null : null
    const resolved = own ?? owningSession(start.parent_uuid)
    sessionOf.set(uuid, resolved)

    return resolved
  }

  for (const [uuid, start] of starts) {
    const end = ends.get(uuid)
    const began = relayEventSeconds(start)
    const finished = end ? Math.max(began, relayEventSeconds(end)) : Math.max(began, nowSec)
    const metadata = obj(start.metadata)
    const isSubagent = start.name === SESSION_SCOPE && Boolean(metadata['hermes.parent_session_id'])

    const name =
      start.name === SESSION_SCOPE
        ? isSubagent
          ? labels.subagent
          : labels.session
        : start.name === TURN_SCOPE
          ? turnInputs.get(uuid) || labels.turn
          : start.name === LOGICAL_LLM_SCOPE
            ? labels.llmCall
            : start.category === 'llm'
              ? str(obj(start.category_profile).model_name) || start.name
              : start.name

    spans.push({
      id: uuid,
      parentId: start.parent_uuid && starts.has(start.parent_uuid) ? start.parent_uuid : null,
      name,
      kind: KIND_BY_CATEGORY[start.category ?? ''] ?? 'CHAIN',
      start: began,
      end: finished,
      duration: finished - began,
      status: spanStatus(end),
      sessionId: owningSession(uuid),
      attributes: spanAttributes(start, end)
    })
  }

  const delegatesByParent = new Map<null | string, TraceSpan[]>()

  for (const span of spans) {
    if (span.kind === 'TOOL' && span.attributes['tool.name'] === DELEGATE_TOOL) {
      delegatesByParent.set(span.parentId, [...(delegatesByParent.get(span.parentId) ?? []), span])
    }
  }

  for (const span of spans) {
    if (span.kind === 'AGENT' && span.parentId) {
      const spawner = delegatesByParent.get(span.parentId)?.find(d => d.start <= span.start && span.start <= d.end)

      if (spawner) {
        span.parentId = spawner.id
      }
    }
  }

  settleOpenSessions(spans, starts, ends)

  const start = spans.length ? Math.min(...spans.map(s => s.start)) : nowSec
  const end = spans.length ? Math.max(...spans.map(s => s.end)) : nowSec
  const root = spans.find(s => s.parentId === null && s.kind === 'AGENT')

  return { rootSessionId: root?.sessionId ?? '', start, end, duration: end - start, spans }
}

/**
 * A session scope stays open for the whole conversation, so "open" is not "working":
 * between turns it ends where its last child ended and is only running while a child is.
 */
function settleOpenSessions(spans: TraceSpan[], starts: Map<string, RelayEvent>, ends: Map<string, RelayEvent>) {
  const children = new Map<string, TraceSpan[]>()

  for (const span of spans) {
    if (span.parentId) {
      children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
    }
  }

  const settle = (span: TraceSpan): { end: number; running: boolean } => {
    const kids = (children.get(span.id) ?? []).map(settle)
    const open = !ends.has(span.id) && starts.get(span.id)?.name === SESSION_SCOPE

    if (open) {
      span.end = Math.max(span.start, ...kids.map(k => k.end))
      span.duration = span.end - span.start
      span.status = kids.some(k => k.running) ? 'running' : 'unset'
    }

    return { end: span.end, running: span.status === 'running' || kids.some(k => k.running) }
  }

  for (const span of spans) {
    if (span.parentId === null) {
      settle(span)
    }
  }
}

/** The root session's turns, oldest first. */
export function traceTurns(doc: TraceDoc): TraceTurnSummary[] {
  const roots = new Set(doc.spans.filter(s => s.parentId === null).map(s => s.id))

  return doc.spans
    .filter(s => s.parentId !== null && roots.has(s.parentId) && s.kind === 'CHAIN')
    .sort((a, b) => a.start - b.start)
    .map((turn, index) => ({
      id: turn.id,
      index,
      label: turn.name,
      start: turn.start,
      end: turn.end,
      duration: turn.duration,
      running: turn.status === 'running'
    }))
}

/** One turn as its own trace: the turn span becomes the root of its subtree. */
export function turnTrace(doc: TraceDoc, turnId: string): TraceDoc {
  const children = new Map<string, TraceSpan[]>()

  for (const span of doc.spans) {
    if (span.parentId) {
      children.set(span.parentId, [...(children.get(span.parentId) ?? []), span])
    }
  }

  const turn = doc.spans.find(s => s.id === turnId)

  if (!turn) {
    return { ...doc, spans: [] }
  }

  const spans: TraceSpan[] = [{ ...turn, parentId: null }]

  for (let i = 0; i < spans.length; i++) {
    spans.push(...(children.get(spans[i]!.id) ?? []))
  }

  return { ...doc, start: turn.start, end: turn.end, duration: turn.duration, spans }
}
