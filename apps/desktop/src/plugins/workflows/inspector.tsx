/**
 * The step detail panel. Same sheet as the Kanban task drawer: SidePanel
 * chrome, meta rows for knobs, sections for prose and lists. Config is the
 * step as authored; Data is the step as run.
 *
 * Which knobs Config offers is the schema's answer (`hasField`), not the
 * kind's. Every edit leaves as a graph op — the panel never reaches into
 * node data itself.
 */

import {
  Button,
  Callout,
  cn,
  Codicon,
  CopyButton,
  Field,
  FieldHint,
  FieldStatusSlot,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidePanelAction,
  SidePanelBody,
  SidePanelClose,
  SidePanelHeader,
  SidePanelMeta,
  SidePanelMetaRow,
  SidePanelSection,
  SidePanelTitleInput,
  SidePanelToolbar,
  Stepper,
  Switch,
  Textarea,
  TextTab,
  useValue
} from '@hermes/plugin-sdk'
import type { Node } from '@xyflow/react'
import { useMemo, useState } from 'react'

import { $currentId, $webhooks } from './documents'
import {
  addArm,
  armsOf,
  armTargets,
  type Graph,
  type OpResult,
  type Problem,
  removeArm,
  setBranch,
  setKind,
  validate
} from './graph'
import type { NodeData } from './nodes'
import type { StepRuntime } from './protocol'
import {
  type Check,
  CHECK_FIELDS,
  CHECK_OPS,
  defaultPredicate,
  hasField,
  JOIN_OPTIONS,
  ON_FAIL_OPTIONS,
  type OnFail,
  type Predicate,
  PREDICATE_MODES,
  type PredicateMode,
  STEP_KINDS,
  type StepConfig,
  TRIGGER_KIND_OPTIONS,
  type TriggerKind,
  WAIT_KIND_OPTIONS,
  type WaitKind
} from './scenario'
import { $strict, statusesFor, statusFor } from './validation'

const TODO_MARK: Record<string, string> = {
  cancelled: '[~]',
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]'
}

/** Radix forbids `""` as an item value; empty here is a real choice (inherit). */
const NONE = '\u0000none'

type Choice = string | { label: string; value: string }

const choiceValue = (o: Choice) => (typeof o === 'string' ? o : o.value)
const choiceLabel = (o: Choice) => (typeof o === 'string' ? o : o.label)

/** The same Select stack Kanban's profile picker uses, for a list of options. */
function Choices({
  onChange,
  options,
  placeholder,
  title,
  value
}: {
  onChange: (v: string) => void
  options: readonly Choice[]
  placeholder?: string
  title?: string
  value: string
}) {
  return (
    <Select onValueChange={v => onChange(v === NONE ? '' : v)} value={value === '' ? NONE : value}>
      <SelectTrigger aria-label={title} className="nodrag" size="sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {placeholder !== undefined && <SelectItem value={NONE}>{placeholder}</SelectItem>}
        {options.map(o => (
          <SelectItem key={choiceValue(o)} value={choiceValue(o)}>
            {choiceLabel(o)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ConditionRow({
  check,
  onChange,
  onRemove,
  steps
}: {
  check: Check
  onChange: (next: Check) => void
  onRemove: () => void
  steps: Node[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <Choices onChange={v => onChange({ ...check, step: v })} options={steps.map(n => n.id)} value={check.step} />
        <Choices
          onChange={v => onChange({ ...check, field: v as Check['field'] })}
          options={CHECK_FIELDS}
          value={check.field}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Choices onChange={v => onChange({ ...check, op: v as Check['op'] })} options={CHECK_OPS} value={check.op} />
        <Input
          className="nodrag min-w-0 flex-1"
          onChange={e => onChange({ ...check, value: e.target.value })}
          placeholder="PASS"
          size="sm"
          value={check.value}
        />
        <Button aria-label="Remove this condition" onClick={onRemove} size="icon-xs" variant="ghost">
          <Codicon name="close" size="0.75rem" />
        </Button>
      </div>
    </div>
  )
}

function BranchEditor({
  gateId,
  graph,
  onOp,
  problems,
  strict
}: {
  gateId: string
  graph: Graph
  onOp: (op: OpResult) => OpResult
  problems: Problem[]
  strict: boolean
}) {
  const arms = armsOf(graph, gateId)
  const steps = graph.nodes.filter(n => n.id !== gateId && !!(n.data as NodeData)?.def)
  const titleOf = (id: string) => (graph.nodes.find(n => n.id === id)?.data as NodeData)?.config.title ?? id
  const table = statusesFor(problems, strict, 'arms')

  return (
    <SidePanelSection
      action={
        <Button onClick={() => onOp(addArm(graph, gateId))} size="xs" variant="ghost">
          <Codicon name="add" size="0.75rem" />
          Add
        </Button>
      }
      label="Routing rules"
    >
      <FieldHint>Taken in order — the first rule that matches wins.</FieldHint>
      {/* About the table as a whole — too few arms, no default — rather than
          about any one rule below. */}
      {table.map((s, i) => (
        <FieldHint error={s.level === 'error'} key={i}>
          {s.message}
        </FieldHint>
      ))}

      <div className="flex flex-col gap-4">
        {arms.map(arm => {
          const when = arm.when
          const set = (next: Predicate) => onOp(setBranch(graph, gateId, arm.id, { when: next }))
          const goes = armTargets(graph, gateId, arm.id)

          return (
            <div className="flex flex-col gap-3" key={arm.id}>
              <Field label="Output">
                <div className="flex items-center gap-1">
                  <Input
                    className="nodrag"
                    onChange={ev => onOp(setBranch(graph, gateId, arm.id, { label: ev.target.value }))}
                    placeholder={goes.map(e => titleOf(e.target)).join(', ') || 'Unnamed output'}
                    size="sm"
                    title="What the canvas calls this output."
                    value={arm.label ?? ''}
                  />
                  <Button
                    aria-label="Remove this output"
                    onClick={() => onOp(removeArm(graph, gateId, arm.id))}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Codicon name="close" size="0.75rem" />
                  </Button>
                </div>
              </Field>
              {/* Where it goes, when it goes anywhere. When it doesn't, that's
                  a diagnostic, and it comes through the same slot as the rest
                  of them at the foot of the rule. */}
              {!!goes.length && !!arm.label?.trim() && (
                <p className="text-[0.75rem] text-(--ui-text-tertiary)">
                  → {goes.map(e => titleOf(e.target)).join(', ')}
                </p>
              )}

              <Field label="When" tip={PREDICATE_MODES.find(p => p.value === when.mode)?.hint}>
                <Choices
                  onChange={m => set(defaultPredicate(m as PredicateMode))}
                  options={PREDICATE_MODES.map(p => ({ label: p.label, value: p.value }))}
                  value={when.mode}
                />
              </Field>

              {when.mode === 'prose' && (
                <Textarea
                  className="nodrag nowheel min-h-24 text-[0.75rem]"
                  onChange={e => set({ mode: 'prose', source: e.target.value })}
                  placeholder="What the gate should weigh before taking this arm…"
                  rows={2}
                  value={when.source}
                />
              )}

              {when.mode === 'checks' && (
                <div className="flex flex-col gap-3">
                  {when.checks.map((c, i) => (
                    <div className="flex flex-col gap-1.5" key={i}>
                      {i > 0 && (
                        <Choices
                          onChange={v => set({ ...when, join: v as 'all' | 'any' })}
                          options={JOIN_OPTIONS}
                          value={when.join}
                        />
                      )}
                      <ConditionRow
                        check={c}
                        onChange={next => set({ ...when, checks: when.checks.map((x, j) => (j === i ? next : x)) })}
                        onRemove={() => set({ ...when, checks: when.checks.filter((_, j) => j !== i) })}
                        steps={steps}
                      />
                    </div>
                  ))}
                  <Button
                    onClick={() =>
                      set({
                        ...when,
                        checks: [...when.checks, { field: 'verdict', op: 'is', step: steps[0]?.id ?? '', value: 'PASS' }]
                      })
                    }
                    size="xs"
                    variant="ghost"
                  >
                    <Codicon name="add" size="0.75rem" />
                    Add condition
                  </Button>
                </div>
              )}

              {statusesFor(problems, strict, 'arms', arm.id).map((s, i) => (
                <FieldHint error={s.level === 'error'} key={i}>
                  {s.message}
                </FieldHint>
              ))}
            </div>
          )
        })}
      </div>
    </SidePanelSection>
  )
}

export function Inspector({
  graph,
  node,
  onChange,
  onClose,
  onDelete,
  onOp,
  rt
}: {
  graph: Graph
  node: Node
  onChange: (patch: Partial<StepConfig>) => void
  onClose: () => void
  onDelete: () => void
  onOp: (op: OpResult) => OpResult
  rt: StepRuntime
}) {
  const { config, def } = node.data as NodeData
  const [tab, setTab] = useState<'config' | 'data'>('config')

  const has = (f: keyof StepConfig) => hasField(def.kind, f)
  const isGate = def.kind === 'gate'
  const isHuman = def.kind === 'human'
  const budgets = (['maxIterations', 'maxRetries', 'timeoutMins'] as const).some(has)
  const problems = useMemo(() => validate(graph).filter(p => p.step === def.id), [def.id, graph])
  const strict = useValue($strict)
  const st = (field: keyof StepConfig) => statusFor(problems, strict, field)
  // What's wrong with the step's wiring rather than with anything you could
  // type here — it has no control to sit under, so it keeps the banner.
  const unplaced = problems.filter(p => !p.field)
  const webhook = useValue($webhooks)[useValue($currentId) ?? '']

  return (
    <>
      <SidePanelHeader>
        <SidePanelToolbar>
          <SidePanelTitleInput
            className="min-w-0 flex-1"
            onChange={e => onChange({ title: e.target.value })}
            value={config.title}
          />
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <SidePanelAction aria-label="Delete this step" onClick={onDelete}>
              <Codicon name="trash" size="0.8rem" />
            </SidePanelAction>
            <SidePanelClose onClick={onClose} />
          </div>
        </SidePanelToolbar>
        <div className="flex gap-3">
          <TextTab active={tab === 'config'} onClick={() => setTab('config')}>
            Config
          </TextTab>
          <TextTab active={tab === 'data'} onClick={() => setTab('data')}>
            Data
          </TextTab>
        </div>
      </SidePanelHeader>

      <SidePanelBody className="nodrag nowheel" fade>
        {tab === 'config' ? (
          <div className="flex flex-col gap-4 text-sm">
            {unplaced.map((p, i) => (
              <Callout
                icon={p.level === 'error' ? 'error' : 'warning'}
                key={i}
                title={p.message}
                tone={p.level === 'error' ? 'var(--destructive, #f87171)' : '#fbbf24'}
              />
            ))}

            <SidePanelMeta>
              <SidePanelMetaRow
                control
                label="Type"
                tip="What runs this step. Changing it keeps the name, the instruction and the wiring."
              >
                <SegmentedControl
                  className="nodrag w-full"
                  onChange={k => onOp(setKind(graph, def.id, k))}
                  options={STEP_KINDS.map(k => ({ id: k.kind, label: k.title }))}
                  value={def.kind}
                />
              </SidePanelMetaRow>

              {has('model') && (
                <SidePanelMetaRow control label="Model" tip="Overrides the model for this step only. Empty inherits this profile's default.">
                  <Input
                    className="nodrag"
                    onChange={e => onChange({ model: e.target.value })}
                    placeholder="inherit"
                    value={config.model ?? ''}
                  />
                </SidePanelMetaRow>
              )}

              {has('onFail') && (
                <SidePanelMetaRow
                  control
                  label="On failure"
                  tip={
                    isHuman
                      ? 'What the run does if nobody answers in time.'
                      : 'What the run does when this step exhausts its retries.'
                  }
                >
                  <SegmentedControl
                    className="nodrag w-full"
                    onChange={(v: OnFail) => onChange({ onFail: v })}
                    options={ON_FAIL_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
                    value={config.onFail ?? 'retry'}
                  />
                </SidePanelMetaRow>
              )}

              {has('assignee') && (
                <SidePanelMetaRow control label="Assignee" tip="Who the run parks on. Empty means whoever is watching.">
                  <Input
                    className="nodrag"
                    onChange={e => onChange({ assignee: e.target.value })}
                    placeholder="anyone"
                    size="sm"
                    value={config.assignee ?? ''}
                  />
                </SidePanelMetaRow>
              )}

              {has('on') && (
                <>
                  <SidePanelMetaRow control label="Starts on" tip="What begins a run of this workflow.">
                    <SegmentedControl
                      className="nodrag w-full"
                      onChange={(v: TriggerKind) => onChange({ on: { spec: config.on?.spec ?? '', type: v } })}
                      options={TRIGGER_KIND_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
                      value={config.on?.type ?? 'manual'}
                    />
                  </SidePanelMetaRow>
                  {(config.on?.type ?? 'manual') !== 'manual' && (
                    <SidePanelMetaRow
                      control
                      label="When"
                      status={st('on')}
                      tip={TRIGGER_KIND_OPTIONS.find(o => o.value === (config.on?.type ?? 'manual'))?.hint}
                    >
                      <Input
                        className="nodrag"
                        onChange={e => onChange({ on: { spec: e.target.value, type: config.on?.type ?? 'cron' } })}
                        placeholder={
                          (config.on?.type ?? 'cron') === 'cron'
                            ? 'every 2h'
                            : (config.on?.type ?? 'cron') === 'webhook'
                              ? 'saved on the gateway as wf:<workflow>'
                              : 'github.pull_request.merged'
                        }
                        size="sm"
                        value={config.on?.spec ?? ''}
                      />
                    </SidePanelMetaRow>
                  )}
                  {(config.on?.type ?? 'manual') === 'webhook' && webhook && (
                    <>
                      <SidePanelMetaRow control label="Route" tip="POST this path on the webhook gateway.">
                        <div className="flex items-center gap-1">
                          <Input
                            className="nodrag min-w-0 flex-1"
                            readOnly
                            size="sm"
                            value={`/webhooks/${webhook.route}`}
                          />
                          <CopyButton appearance="icon" buttonSize="icon-xs" text={`/webhooks/${webhook.route}`} />
                        </div>
                      </SidePanelMetaRow>
                      <SidePanelMetaRow control label="HMAC" tip="Stored under HERMES_HOME/workflows/secrets.json.">
                        <div className="flex items-center gap-1">
                          <Input className="nodrag min-w-0 flex-1" readOnly size="sm" value={webhook.secret} />
                          <CopyButton appearance="icon" buttonSize="icon-xs" text={webhook.secret} />
                        </div>
                      </SidePanelMetaRow>
                    </>
                  )}
                </>
              )}

              {has('until') && (
                <>
                  <SidePanelMetaRow control label="Waiting on" tip="What the world has to do before the run moves on.">
                    <SegmentedControl
                      className="nodrag w-full"
                      onChange={(v: WaitKind) => onChange({ until: { spec: config.until?.spec ?? '', type: v } })}
                      options={WAIT_KIND_OPTIONS.map(o => ({ id: o.value, label: o.label }))}
                      value={config.until?.type ?? 'timer'}
                    />
                  </SidePanelMetaRow>
                  <SidePanelMetaRow
                    control
                    label="Condition"
                    status={st('until')}
                    tip={WAIT_KIND_OPTIONS.find(o => o.value === (config.until?.type ?? 'timer'))?.hint}
                  >
                    <Input
                      className="nodrag"
                      onChange={e =>
                        onChange({ until: { spec: e.target.value, type: config.until?.type ?? 'timer' } })
                      }
                      placeholder={
                        (config.until?.type ?? 'timer') === 'timer'
                          ? '24h'
                          : (config.until?.type ?? 'timer') === 'event'
                            ? 'github.pull_request.merged'
                            : 'every 5m'
                      }
                      size="sm"
                      value={config.until?.spec ?? ''}
                    />
                  </SidePanelMetaRow>
                </>
              )}

              {has('maxLoops') && (
                <Field label="Max takes" row tip="How many takes the gate may send back before giving up.">
                  <Stepper
                    className="nodrag"
                    max={20}
                    min={1}
                    onChange={v => onChange({ maxLoops: v })}
                    value={config.maxLoops ?? 0}
                  />
                </Field>
              )}

              {has('blind') && (
                <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-(--ui-text-secondary)">
                  <Switch
                    aria-label="Blind to upstream output"
                    checked={!!config.blind}
                    className="nodrag"
                    onCheckedChange={v => onChange({ blind: v })}
                    size="xs"
                  />
                  Blind to upstream output
                </label>
              )}
            </SidePanelMeta>

            {has('goal') && (
              <SidePanelSection
                label={isHuman ? 'Ask' : 'Goal'}
                title={
                  isHuman
                    ? "Shown when the run parks here. Your answer is this step's output."
                    : "Sent to delegate_task as the subagent's goal."
                }
              >
                <FieldStatusSlot status={st('goal')}>
                  <Textarea
                    className="nodrag nowheel min-h-24 text-[0.75rem]"
                    onChange={e => onChange({ goal: e.target.value })}
                    rows={3}
                    value={config.goal ?? ''}
                  />
                </FieldStatusSlot>
              </SidePanelSection>
            )}

            {budgets && (
              <SidePanelSection label="Budgets">
                {has('maxIterations') && (
                  <Field label="Iterations" row tip="Tool-call budget before the subagent must stop.">
                    <Stepper
                      className="nodrag"
                      max={200}
                      min={1}
                      onChange={v => onChange({ maxIterations: v })}
                      step={5}
                      value={config.maxIterations ?? 20}
                    />
                  </Field>
                )}
                {has('maxRetries') && (
                  <Field label="Retries" row tip="Takes before the step reports failed.">
                    <Stepper
                      className="nodrag"
                      max={10}
                      min={0}
                      onChange={v => onChange({ maxRetries: v })}
                      value={config.maxRetries ?? 1}
                    />
                  </Field>
                )}
                {has('timeoutMins') && (
                  <Field
                    label="Timeout"
                    row
                    tip={
                      isHuman
                        ? 'How long the run parks here before nobody answering counts as a failure. ∞ = wait forever.'
                        : 'Wall-clock cap on a single take. ∞ = no cap.'
                    }
                  >
                    <Stepper
                      className="nodrag"
                      max={180}
                      min={0}
                      onChange={v => onChange({ timeoutMins: v })}
                      step={5}
                      suffix={(config.timeoutMins ?? 0) > 0 ? 'min' : undefined}
                      unboundedAtMin
                      value={config.timeoutMins ?? 0}
                    />
                  </Field>
                )}
              </SidePanelSection>
            )}

            {has('arms') && (
              <BranchEditor gateId={def.id} graph={graph} onOp={onOp} problems={problems} strict={strict} />
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <SidePanelMeta>
              <SidePanelMetaRow label="Status">
                {rt.status}
                {rt.verdict ? ` · ${rt.verdict}` : ''}
              </SidePanelMetaRow>
              {rt.durationMs != null && (
                <SidePanelMetaRow label="Duration">{(rt.durationMs / 1000).toFixed(1)}s</SidePanelMetaRow>
              )}
              {rt.tokens > 0 && (
                <SidePanelMetaRow label="Tokens">
                  {rt.tokens >= 1000 ? `${(rt.tokens / 1000).toFixed(1)}k` : rt.tokens}
                </SidePanelMetaRow>
              )}
              {rt.maxIters > 0 && rt.iterations > 0 && (
                <SidePanelMetaRow label="Iterations">
                  {rt.iterations}/{rt.maxIters}
                </SidePanelMetaRow>
              )}
              {rt.take > 1 && <SidePanelMetaRow label="Take">{rt.take}</SidePanelMetaRow>}
              <SidePanelMetaRow label={isGate ? 'Children' : 'Input'} wrap>
                {rt.input ?? '—'}
              </SidePanelMetaRow>
              <SidePanelMetaRow label={isGate ? 'Decision' : 'Summary'} wrap>
                {rt.summary ?? '—'}
              </SidePanelMetaRow>
            </SidePanelMeta>

            {rt.output && (
              <SidePanelSection action={<Count n={Object.keys(rt.output).length} />} label="Output">
                <ul className="flex flex-col gap-2">
                  {Object.entries(rt.output).map(([k, v]) => (
                    <li className="text-[0.75rem]" key={k}>
                      <span className="font-medium text-(--ui-text-secondary)">{k}</span>
                      <div className="whitespace-pre-wrap text-(--ui-text-tertiary)">{renderFieldValue(v)}</div>
                    </li>
                  ))}
                </ul>
              </SidePanelSection>
            )}

            {rt.todos.length > 0 && (
              <SidePanelSection
                action={<Count n={`${rt.todos.filter(t => t.status === 'completed').length}/${rt.todos.length}`} />}
                label="Plan · todo tool"
              >
                <ul className="flex flex-col gap-1">
                  {rt.todos.map(t => (
                    <li className="flex items-baseline gap-2 text-[0.6875rem]" key={t.id}>
                      <span className="shrink-0 text-(--ui-text-quaternary)">{TODO_MARK[t.status]}</span>
                      <span
                        className={cn(
                          'min-w-0 text-(--ui-text-secondary)',
                          (t.status === 'completed' || t.status === 'cancelled') &&
                            'text-(--ui-text-tertiary) line-through'
                        )}
                      >
                        {t.content}
                      </span>
                    </li>
                  ))}
                </ul>
              </SidePanelSection>
            )}

            {rt.toolCalls.length > 0 && (
              <SidePanelSection action={<Count n={rt.toolCalls.length} />} label="Activity">
                <ul className="flex flex-col gap-1">
                  {rt.toolCalls.map((c, i) => (
                    <li className="flex items-baseline gap-2 text-[0.6875rem]" key={i}>
                      <span className="shrink-0 text-(--ui-text-secondary)">{c.name}</span>
                      {c.arg && (
                        <span className="min-w-0 truncate text-[0.625rem] text-(--ui-text-quaternary)" title={c.arg}>
                          {c.arg}
                        </span>
                      )}
                    </li>
                  ))}
                  {rt.currentTool && (rt.status === 'running' || rt.status === 'looping') && (
                    <li className="flex items-baseline gap-2 text-[0.6875rem]">
                      <span className="shrink-0 text-(--ui-text-secondary)">{rt.currentTool.name}</span>
                      {rt.currentTool.arg && (
                        <span className="min-w-0 truncate text-[0.625rem] text-(--ui-text-quaternary)">
                          {rt.currentTool.arg}
                        </span>
                      )}
                    </li>
                  )}
                </ul>
              </SidePanelSection>
            )}
          </div>
        )}
      </SidePanelBody>
    </>
  )
}

function renderFieldValue(v: unknown): React.ReactNode {
  if (Array.isArray(v)) {
    return v.length ? v.join(', ') : '[]'
  }

  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${String(val)}`)
      .join(', ')
  }

  if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
    return (
      <a className="node-link" href={v} rel="noreferrer" target="_blank">
        {v}
      </a>
    )
  }

  return String(v)
}

function Count({ n }: { n: number | string }) {
  return <span className="text-[0.62rem] tabular-nums text-(--ui-text-quaternary)">{n}</span>
}
