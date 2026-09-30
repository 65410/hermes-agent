import { type ComponentProps, useId } from 'react'
import { useI18n } from '@/i18n'
import { Switch } from '@/components/ui/switch'

/** Visible action copy stays attached to the actual controlled switch. */
export function CatalogSwitch(props: ComponentProps<typeof Switch>) {
  const id = useId()
  const { t } = useI18n()
  return <label htmlFor={id} className="catalog-switch relative inline-flex shrink-0 items-center gap-2 text-xs text-(--ui-text-secondary)">
    <span>{props.checked ? t.plugins.disable : t.plugins.enable}</span>
    <Switch {...props} id={id} />
  </label>
}
