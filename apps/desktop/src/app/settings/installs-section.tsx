import { type ReactElement, useCallback, useContext, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DesktopInstallsEntry, DesktopInstallsList } from '@/global'
import { type Translations, useI18n } from '@/i18n'
import { Loader2, Package } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { SectionHeading, SettingsBreadcrumbContext } from './primitives'

type Bridge = NonNullable<Window['hermesDesktop']['installs']>
type InstallsPageCopy = Translations['settings']['installsPage']

/**
 * Settings page for the other Hermes installs on this machine. Data comes from
 * `hermes installs list --json` through the installs IPC bridge, so `current`
 * is the install this app runs from. Removal goes through
 * `hermes installs remove <id> --yes`. The CLI refuses the running install and
 * the `removable` / `refusal` fields carry that refusal to the UI.
 */
export function InstallsSection(): ReactElement | null {
  const hasBreadcrumb = useContext(SettingsBreadcrumbContext)
  const { t } = useI18n()
  const u = t.settings.installsPage

  const bridge: Bridge | undefined = window.hermesDesktop?.installs

  const [list, setList] = useState<DesktopInstallsList | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [failed, setFailed] = useState<boolean>(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<boolean>(false)
  const [removedId, setRemovedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyList = (result: DesktopInstallsList | null): void => {
    if (result) {
      setList(result)
    } else {
      setFailed(true)
      setList(null)
    }
  }

  const refresh = useCallback((): void => {
    if (!bridge) {
      return
    }

    setLoading(true)
    setFailed(false)

    void bridge
      .list()
      .then((result: DesktopInstallsList | null): void => {
        applyList(result)
      })
      .catch((): void => {
        applyList(null)
      })
      .finally((): void => {
        setLoading(false)
      })
  }, [bridge])

  useEffect(refresh, [refresh])

  if (!bridge) {
    return null
  }

  const handleConfirm: () => Promise<void> = async (): Promise<void> => {
    if (!pendingId) {
      return
    }

    setRemoving(true)
    setError(null)

    try {
      const result = await bridge.remove(pendingId)

      if (!result.ok) {
        setError(result.message || result.error || u.removeFailed)
      } else {
        setRemovedId(pendingId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }

    setRemoving(false)
    setPendingId(null)
    refresh()
  }

  const handleHideNotice = (): void => {
    void bridge.dismiss().then((): void => {
      refresh()
    })
  }

  const pending: DesktopInstallsEntry | null = list?.installs.find(e => e.id === pendingId) ?? null
  const noticeVisible: boolean = list !== null && list.notice.count > 0 && !list.notice.dismissed
  const firstLauncher = list?.launchers[0] ?? null

  return (
    <div className={cn('mx-auto w-full max-w-2xl', !hasBreadcrumb && 'mt-8')}>
      <SectionHeading icon={Package} page title={u.title} />

      <p className="mt-2 text-xs text-muted-foreground">{u.description}</p>

      {loading && !list && (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {u.loading}
        </p>
      )}

      {failed && (
        <div className="mt-6 rounded-xl border border-border/60 px-4 py-3">
          <p className="text-sm text-muted-foreground">{u.loadFailed}</p>
          <Button className="mt-2" onClick={refresh} size="sm" variant="text">
            {u.reload}
          </Button>
        </div>
      )}

      {list && (
        <>
          {firstLauncher && (
            <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground/60">
              {u.launcherWins(firstLauncher.path, firstLauncher.owner ?? u.launcherUnknown)}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {list.installs.map(entry => (
              <InstallRow
                entry={entry}
                key={entry.id}
                onRemove={(): void => {
                  setError(null)
                  setRemovedId(null)
                  setPendingId(entry.id)
                }}
                u={u}
              />
            ))}
          </div>

          {removedId && <p className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">{u.removed(removedId)}</p>}

          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

          {noticeVisible && (
            <div className="mt-6 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
              <p className="text-sm">{u.noticeTitle(list.notice.count)}</p>
              <p className="mt-1 text-xs text-muted-foreground">{u.noticeBody}</p>
              <Button className="mt-2" onClick={handleHideNotice} size="sm" variant="text">
                {u.hideNotice}
              </Button>
            </div>
          )}

          {pending && (
            <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm font-medium text-destructive">{u.confirmTitle}</p>
              <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground">{pending.root}</p>
              <p className="mt-1 text-xs text-muted-foreground">{u.confirmBody}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button disabled={removing} onClick={(): void => void handleConfirm()} size="sm" variant="destructive">
                  {removing && <Loader2 className="size-3 animate-spin" />}
                  {removing ? u.removing : u.confirmYes}
                </Button>
                <Button disabled={removing} onClick={(): void => setPendingId(null)} size="sm" variant="text">
                  {t.common.cancel}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function InstallRow({
  entry,
  onRemove,
  u
}: {
  entry: DesktopInstallsEntry
  onRemove: () => void
  u: InstallsPageCopy
}): ReactElement {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs break-all">{entry.root}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {u.idLabel} {entry.id} · {u.stewardLabel} {entry.steward} · {u.versionLabel} {entry.version ?? '—'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[0.62rem] font-medium',
              entry.current
                ? 'bg-emerald-600/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {entry.current ? u.running : u.other}
          </span>
          <Button disabled={!entry.removable} onClick={onRemove} size="sm" variant="destructive">
            {u.remove}
          </Button>
        </div>
      </div>
      {!entry.removable && entry.refusal && <p className="mt-2 text-xs text-muted-foreground">{entry.refusal}</p>}
    </div>
  )
}
