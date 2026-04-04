import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { ScrollArea } from 'radix-ui'
import { useCanvasStore } from '@/lib/canvasStore'
import {
  useBridgeStore,
  type EffectInfo,
  type EffectParamDependency,
  type EffectParamInfo,
  type LocalizedText,
} from '@/lib/bridge'
import { t, useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type VisibleParamEntry = {
  param: EffectParamInfo
  disabled: boolean
  groupLabel: string | null
  showGroup: boolean
}

function resolveLocalizedText(value: LocalizedText | undefined, locale: string): string {
  if (!value) return ''
  if (value.byLocale?.[locale]) return value.byLocale[locale]

  const localeBase = locale.split('-')[0]
  const matchedLocale = Object.keys(value.byLocale ?? {}).find((key) => key.split('-')[0] === localeBase)
  if (matchedLocale && value.byLocale?.[matchedLocale]) return value.byLocale[matchedLocale]

  return value.raw ?? ''
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T
  }
  return value
}

function getDefaultParamValue(param: EffectParamInfo): unknown {
  return cloneValue(param.default)
}

function buildEffectiveParams(
  schema: EffectParamInfo[],
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current }
  for (const param of schema) {
    if (!(param.key in next) && param.default !== undefined) {
      next[param.key] = getDefaultParamValue(param)
    }
  }
  return next
}

function evaluateDependency(
  dependency: EffectParamDependency | null | undefined,
  values: Record<string, unknown>,
) {
  if (!dependency?.key) return { hidden: false, disabled: false }

  const dependentValue = values[dependency.key]
  let matched = true
  if ('equals' in dependency) matched = dependentValue === dependency.equals
  if ('not_equals' in dependency) matched = dependentValue !== dependency.not_equals
  if (matched) return { hidden: false, disabled: false }

  return {
    hidden: dependency.behavior === 'hide',
    disabled: dependency.behavior !== 'hide',
  }
}

function normalizeNumber(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatNumber(value: number, step?: number) {
  const precision = step && step < 1
    ? Math.min(3, Math.max(0, `${step}`.split('.')[1]?.length ?? 0))
    : 0
  return value.toFixed(precision)
}

function normalizeColor(value: unknown, fallback = '#ffffff') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function normalizeRangeValue(param: EffectParamInfo, value: unknown): [number, number] {
  const min = normalizeNumber(param.min, 0)
  const max = normalizeNumber(param.max, 100)
  const fallback = Array.isArray(param.default) ? param.default : [min, max]
  const raw = Array.isArray(value) ? value : fallback
  const start = Math.min(max, Math.max(min, normalizeNumber(raw[0], min)))
  const end = Math.min(max, Math.max(start, normalizeNumber(raw[1], max)))
  return [start, end]
}

function normalizeMultiColorValue(param: EffectParamInfo, value: unknown): string[] {
  const fallback = Array.isArray(param.default) ? param.default : ['#ffffff']
  const raw = Array.isArray(value) ? value : fallback
  const normalized = raw
    .map(color => normalizeColor(color))
    .filter(Boolean)

  return normalized.length > 0 ? normalized : ['#ffffff']
}

function serializeOptionValue(value: unknown) {
  const serialized = JSON.stringify(value)
  return typeof serialized === 'string' ? serialized : String(value)
}

function parseOptionValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function formatDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function areParamValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((entry, index) => areParamValuesEqual(entry, right[index]))
  }

  return Object.is(left, right)
}

function SettingSwitch({
  checked,
  disabled = false,
  onToggle,
}: {
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
        checked
          ? 'border-primary bg-primary/90'
          : 'border-border bg-secondary',
      )}
      onClick={onToggle}
      aria-pressed={checked}
    >
      <span
        className={cn(
          'block size-[16px] rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

function BasicSettingRow({
  label,
  hint,
  control,
  disabled = false,
}: {
  label: string
  hint?: string
  control: ReactNode
  disabled?: boolean
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2.5 border-b border-foreground/[0.05] last:border-b-0',
      disabled && 'opacity-55',
    )}>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-foreground/85">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">
            {hint}
          </div>
        ) : null}
      </div>
      <div className="shrink-0 w-[152px] max-w-[56%]">
        {control}
      </div>
    </div>
  )
}

function EffectParamField({
  param,
  value,
  disabled,
  locale,
  onChange,
}: {
  param: EffectParamInfo
  value: unknown
  disabled: boolean
  locale: string
  onChange: (nextValue: unknown) => void
}) {
  const label = resolveLocalizedText(param.label, locale) || param.key
  const commonClass = 'h-[32px] w-full rounded-[8px] border border-border bg-secondary px-2 text-[12px] text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60'
  const [draftValue, setDraftValue] = useState<unknown>(() => cloneValue(value))
  const [isInteracting, setIsInteracting] = useState(false)
  const draftValueRef = useRef(draftValue)
  const lastCommittedValueRef = useRef<unknown>(cloneValue(value))

  useEffect(() => {
    draftValueRef.current = draftValue
  }, [draftValue])

  useEffect(() => {
    const nextValue = cloneValue(value)
    lastCommittedValueRef.current = nextValue
    if (!isInteracting) {
      setDraftValue(nextValue)
    }
  }, [value, isInteracting])

  const commitDeferredValue = (nextValue?: unknown) => {
    const resolvedValue = cloneValue(nextValue ?? draftValueRef.current)
    setIsInteracting(false)
    setDraftValue(resolvedValue)

    if (areParamValuesEqual(resolvedValue, lastCommittedValueRef.current)) {
      return
    }

    lastCommittedValueRef.current = cloneValue(resolvedValue)
    onChange(resolvedValue)
  }

  useEffect(() => {
    if (!isInteracting || (param.type !== 'slider' && param.type !== 'range_slider')) {
      return
    }

    const handlePointerRelease = () => {
      commitDeferredValue()
    }

    window.addEventListener('pointerup', handlePointerRelease)
    window.addEventListener('pointercancel', handlePointerRelease)

    return () => {
      window.removeEventListener('pointerup', handlePointerRelease)
      window.removeEventListener('pointercancel', handlePointerRelease)
    }
  }, [isInteracting, param.type])

  let control: React.ReactNode = null

  switch (param.type) {
    case 'slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      const step = normalizeNumber(param.step, 1)
      const numericValue = Math.min(max, Math.max(min, normalizeNumber(draftValue, min)))
      control = (
        <div className="flex items-center gap-2">
          <input
            type="range"
            className="w-full accent-[var(--primary)]"
            min={min}
            max={max}
            step={step}
            value={numericValue}
            disabled={disabled}
            onPointerDown={() => setIsInteracting(true)}
            onChange={e => {
              setIsInteracting(true)
              setDraftValue(Number(e.target.value))
            }}
            onKeyUp={e => {
              const targetValue = Number((e.target as HTMLInputElement).value)
              commitDeferredValue(targetValue)
            }}
            onBlur={e => {
              const targetValue = Number(e.target.value)
              commitDeferredValue(targetValue)
            }}
          />
          <span className="w-[52px] shrink-0 text-right text-[11px] text-muted-foreground/80 tabular-nums">
            {formatNumber(numericValue, step)}
          </span>
        </div>
      )
      break
    }

    case 'range_slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      const step = normalizeNumber(param.step, 1)
      const [start, end] = normalizeRangeValue(param, draftValue)

      control = (
        <div className="grid gap-2">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <span className="text-[10px] text-muted-foreground/70">{t('layoutManager.rangeMin')}</span>
            <input
              type="range"
              className="w-full accent-[var(--primary)]"
              min={min}
              max={max}
              step={step}
              value={start}
              disabled={disabled}
              onPointerDown={() => setIsInteracting(true)}
              onChange={e => {
                setIsInteracting(true)
                const nextStart = Math.min(Number(e.target.value), end)
                setDraftValue([nextStart, end])
              }}
              onKeyUp={e => {
                const nextStart = Math.min(Number((e.target as HTMLInputElement).value), end)
                commitDeferredValue([nextStart, end])
              }}
              onBlur={e => {
                const nextStart = Math.min(Number(e.target.value), end)
                commitDeferredValue([nextStart, end])
              }}
            />
            <span className="w-[52px] text-right text-[11px] text-muted-foreground/80 tabular-nums">
              {formatNumber(start, step)}
            </span>
          </div>
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <span className="text-[10px] text-muted-foreground/70">{t('layoutManager.rangeMax')}</span>
            <input
              type="range"
              className="w-full accent-[var(--primary)]"
              min={min}
              max={max}
              step={step}
              value={end}
              disabled={disabled}
              onPointerDown={() => setIsInteracting(true)}
              onChange={e => {
                setIsInteracting(true)
                const nextEnd = Math.max(Number(e.target.value), start)
                setDraftValue([start, nextEnd])
              }}
              onKeyUp={e => {
                const nextEnd = Math.max(Number((e.target as HTMLInputElement).value), start)
                commitDeferredValue([start, nextEnd])
              }}
              onBlur={e => {
                const nextEnd = Math.max(Number(e.target.value), start)
                commitDeferredValue([start, nextEnd])
              }}
            />
            <span className="w-[52px] text-right text-[11px] text-muted-foreground/80 tabular-nums">
              {formatNumber(end, step)}
            </span>
          </div>
        </div>
      )
      break
    }

    case 'select': {
      const options = Array.isArray(param.options) ? param.options : []
      const currentValue = serializeOptionValue(value)
      control = (
        <select
          className={commonClass}
          value={currentValue}
          disabled={disabled}
          onChange={e => onChange(parseOptionValue(e.target.value))}
        >
          {options.map((option, index) => (
            <option key={`${param.key}-${index}`} value={serializeOptionValue(option.value)}>
              {resolveLocalizedText(option.label, locale) || String(option.value)}
            </option>
          ))}
        </select>
      )
      break
    }

    case 'toggle': {
      control = (
        <div className="flex justify-start">
          <SettingSwitch
            checked={value === true}
            disabled={disabled}
            onToggle={() => onChange(value !== true)}
          />
        </div>
      )
      break
    }

    case 'color': {
      const color = normalizeColor(value)
      control = (
        <div className="flex items-center gap-2">
          <input
            type="color"
            className="h-[32px] w-[44px] rounded-[8px] border border-border bg-secondary p-1 disabled:cursor-not-allowed disabled:opacity-60"
            value={color}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
          />
          <div className="flex-1 rounded-[8px] border border-border bg-secondary px-2 py-[7px] text-[11px] text-muted-foreground/80 tabular-nums">
            {color.toUpperCase()}
          </div>
        </div>
      )
      break
    }

    case 'multi_color': {
      const colors = normalizeMultiColorValue(param, value)
      const fixedCount = typeof param.fixedCount === 'number' ? param.fixedCount : null
      const minCount = fixedCount ?? (typeof param.minCount === 'number' ? param.minCount : 1)
      const maxCount = fixedCount ?? (typeof param.maxCount === 'number' ? param.maxCount : 16)
      const canAdd = !disabled && fixedCount == null && colors.length < maxCount
      const canRemove = (count: number) => !disabled && fixedCount == null && count > minCount

      control = (
        <div className="grid gap-2">
          {colors.map((color, index) => (
            <div key={`${param.key}-${index}`} className="flex items-center gap-2">
              <input
                type="color"
                className="h-[32px] w-[44px] rounded-[8px] border border-border bg-secondary p-1 disabled:cursor-not-allowed disabled:opacity-60"
                value={color}
                disabled={disabled}
                onChange={e => {
                  const next = [...colors]
                  next[index] = e.target.value
                  onChange(next)
                }}
              />
              <div className="flex-1 rounded-[8px] border border-border bg-secondary px-2 py-[7px] text-[11px] text-muted-foreground/80 tabular-nums">
                {color.toUpperCase()}
              </div>
              <button
                type="button"
                className="size-[28px] rounded-[8px] border border-border bg-secondary hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors cursor-pointer"
                disabled={!canRemove(colors.length)}
                onClick={() => {
                  const next = colors.filter((_, colorIndex) => colorIndex !== index)
                  onChange(next)
                }}
                title={t('layoutManager.removeColor')}
              >
                <X className="size-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
          {canAdd ? (
            <button
              type="button"
              className="h-[30px] rounded-[8px] border border-dashed border-border bg-secondary/60 hover:bg-accent text-[11px] text-muted-foreground flex items-center justify-center gap-1 transition-colors cursor-pointer"
              onClick={() => onChange([...colors, '#ffffff'])}
            >
              <Plus className="size-3" />
              {t('layoutManager.addColor')}
            </button>
          ) : null}
        </div>
      )
      break
    }

    default: {
      control = (
        <div className="rounded-[8px] border border-dashed border-border bg-secondary/60 px-2 py-[7px] text-[11px] text-muted-foreground/70">
          {t('layoutManager.unsupported')}
        </div>
      )
    }
  }

  return (
    <div className={cn('px-3 py-2.5 border-t border-foreground/[0.05]', disabled && 'opacity-65')}>
      <div className="mb-2 text-[12px] text-foreground/85">{label}</div>
      {control}
    </div>
  )
}

export function LayoutManager() {
  const locale = useLocale()
  const effects = useBridgeStore(s => s.effects)
  const layouts = useBridgeStore(s => s.layouts)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)
  const registerCanvas = useBridgeStore(s => s.registerCanvas)
  const unregisterCanvas = useBridgeStore(s => s.unregisterCanvas)
  const setVirtualDevicePower = useBridgeStore(s => s.setVirtualDevicePower)
  const setVirtualDeviceEffect = useBridgeStore(s => s.setVirtualDeviceEffect)
  const updateVirtualDeviceEffectParams = useBridgeStore(s => s.updateVirtualDeviceEffectParams)
  const resetVirtualDeviceEffectParams = useBridgeStore(s => s.resetVirtualDeviceEffectParams)
  const canvasBounds = useCanvasStore(s => s.canvasBounds)
  const canvasLayoutId = useCanvasStore(s => s.layoutId)

  const activeLayout = useMemo(
    () => layouts.find(layout => layout.id === activeLayoutId) ?? null,
    [layouts, activeLayoutId],
  )

  const sortedEffects = useMemo(
    () => [...effects].sort((left, right) =>
      (resolveLocalizedText(left.name, locale) || left.id)
        .localeCompare(resolveLocalizedText(right.name, locale) || right.id, locale),
    ),
    [effects, locale],
  )

  const selectedEffect = useMemo(
    () => sortedEffects.find(effect => effect.id === activeLayout?.virtual_device.effect_id) ?? null,
    [sortedEffects, activeLayout?.virtual_device.effect_id],
  )

  const effectiveParams = useMemo(
    () => buildEffectiveParams(
      selectedEffect?.params ?? [],
      activeLayout?.virtual_device.effect_params ?? {},
    ),
    [selectedEffect?.params, activeLayout?.virtual_device.effect_params],
  )

  const visibleParams = useMemo<VisibleParamEntry[]>(() => {
    const schema = selectedEffect?.params ?? []
    let lastGroupLabel: string | null = null

    return schema.flatMap((param) => {
      const dependencyState = evaluateDependency(param.dependency, effectiveParams)
      if (dependencyState.hidden) return []

      const groupLabel = resolveLocalizedText(param.group, locale) || null
      const showGroup = groupLabel != null && groupLabel !== lastGroupLabel
      lastGroupLabel = groupLabel ?? lastGroupLabel

      return [{
        param,
        disabled: dependencyState.disabled,
        groupLabel,
        showGroup,
      }]
    })
  }, [selectedEffect?.params, effectiveParams, locale])

  const currentCanvasWidth = activeLayout && canvasLayoutId === activeLayout.id
    ? Math.max(1, Math.round(canvasBounds.width))
    : Math.max(1, Math.round(activeLayout?.canvas.width ?? 1))
  const currentCanvasHeight = activeLayout && canvasLayoutId === activeLayout.id
    ? Math.max(1, Math.round(canvasBounds.height))
    : Math.max(1, Math.round(activeLayout?.canvas.height ?? 1))

  const effectHint = !activeLayout?.registered
    ? t('layoutManager.needRegister')
    : resolveLocalizedText(selectedEffect?.description, locale)

  const panelStatusTitle = activeLayout?.registered
    ? t('layoutManager.status.registered')
    : t('layoutManager.status.unregistered')
  const isRegistered = activeLayout?.registered === true
  const rawOutputPayload = activeLayout?.virtual_device.raw_output ?? null
  const rawOutputAvailable = rawOutputPayload != null
  const rawOutputJson = useMemo(
    () => rawOutputAvailable ? formatDebugJson(rawOutputPayload) : '',
    [rawOutputAvailable, rawOutputPayload],
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 h-[36px] border-b border-foreground/[0.06] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex-1">
          {t('layoutManager.panel')}
        </span>
        <span
          className={cn(
            'size-1.5 rounded-full shrink-0',
            activeLayout?.registered
              ? 'bg-emerald-500'
              : 'bg-muted-foreground/25',
          )}
          title={panelStatusTitle}
        />
      </div>

      <ScrollArea.Root className="flex-1 overflow-hidden">
        <ScrollArea.Viewport className="h-full w-full [&>div]:!block">
          {!activeLayout ? (
            <div className="flex items-center justify-center h-full min-h-[80px]">
              <span className="text-[12px] text-muted-foreground/40">
                {t('layoutManager.noLayout')}
              </span>
            </div>
          ) : (
            <div className="py-1">
              <div className="mx-1 rounded-[6px] overflow-hidden border border-foreground/[0.04] bg-foreground/[0.02]">
                <BasicSettingRow
                  label={t('layoutManager.register')}
                  hint={!isRegistered ? t('layoutManager.needRegister') : undefined}
                  control={(
                    <div className="flex justify-end">
                      <SettingSwitch
                        checked={activeLayout.registered}
                        onToggle={() => {
                          if (activeLayout.registered) {
                            unregisterCanvas(activeLayout.id)
                          } else {
                            registerCanvas(activeLayout.id, currentCanvasWidth, currentCanvasHeight)
                          }
                        }}
                      />
                    </div>
                  )}
                />
                <BasicSettingRow
                  label={t('layoutManager.power')}
                  disabled={!isRegistered}
                  control={(
                    <div className="flex justify-end">
                      <SettingSwitch
                        checked={activeLayout.virtual_device.power_on}
                        disabled={!isRegistered}
                        onToggle={() => setVirtualDevicePower(
                          activeLayout.id,
                          !activeLayout.virtual_device.power_on,
                        )}
                      />
                    </div>
                  )}
                />
                <BasicSettingRow
                  label={t('layoutManager.effect')}
                  hint={effectHint || undefined}
                  disabled={!isRegistered}
                  control={(
                    <select
                      className="h-[32px] w-full rounded-[8px] border border-border bg-secondary px-2 text-[12px] text-foreground outline-none"
                      value={activeLayout.virtual_device.effect_id ?? ''}
                      disabled={!isRegistered}
                      onChange={e => setVirtualDeviceEffect(activeLayout.id, e.target.value || null)}
                    >
                      <option value="">{t('layoutManager.effect.none')}</option>
                      {sortedEffects.map((effect: EffectInfo) => (
                        <option key={effect.id} value={effect.id}>
                          {resolveLocalizedText(effect.name, locale) || effect.id}
                        </option>
                      ))}
                    </select>
                  )}
                />
              </div>

              <div className={cn(
                'mx-1 mt-2 rounded-[6px] overflow-hidden border border-foreground/[0.04] bg-foreground/[0.02]',
                !isRegistered && 'opacity-55',
              )}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex-1">
                    {t('layoutManager.effectSettings')}
                  </span>
                  {selectedEffect ? (
                    <button
                      type="button"
                      className="size-6 rounded-[4px] hover:bg-foreground/[0.06] disabled:hover:bg-transparent disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors cursor-pointer"
                      disabled={!isRegistered}
                      onClick={() => resetVirtualDeviceEffectParams(activeLayout.id)}
                      title={t('layoutManager.reset')}
                    >
                      <RotateCcw className="size-3 text-muted-foreground/60" />
                    </button>
                  ) : null}
                </div>

                {!selectedEffect ? (
                  <div className="px-3 pb-3 text-[12px] text-muted-foreground/55">
                    {sortedEffects.length === 0
                      ? t('layoutManager.noEffects')
                      : t('layoutManager.noEffectSelected')}
                  </div>
                ) : visibleParams.length === 0 ? (
                  <div className="px-3 pb-3 text-[12px] text-muted-foreground/55">
                    {t('layoutManager.noSettings')}
                  </div>
                ) : (
                  visibleParams.map(({ param, disabled, groupLabel, showGroup }) => (
                    <Fragment key={param.key}>
                      {showGroup && groupLabel ? (
                        <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/55">
                          {groupLabel}
                        </div>
                      ) : null}
                      <EffectParamField
                        param={param}
                        value={effectiveParams[param.key]}
                        disabled={!isRegistered || disabled}
                        locale={locale}
                        onChange={(nextValue) => {
                          updateVirtualDeviceEffectParams(activeLayout.id, {
                            ...effectiveParams,
                            [param.key]: nextValue,
                          })
                        }}
                      />
                    </Fragment>
                  ))
                )}
              </div>

              <div className="mx-1 mt-2 rounded-[6px] overflow-hidden border border-foreground/[0.04] bg-foreground/[0.02]">
                <details>
                  <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none">
                    {t('layoutManager.rawJson')}
                    <span className="ml-2 rounded-[999px] border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-normal normal-case tracking-normal text-muted-foreground/65">
                      / canvas
                    </span>
                    <span className="ml-2 text-[10px] font-normal tracking-normal text-muted-foreground/55">
                      {rawOutputAvailable
                        ? t('layoutManager.rawJson.ready')
                        : t('layoutManager.rawJson.unavailable')}
                    </span>
                  </summary>
                  <div className="border-t border-foreground/[0.05] px-3 py-3">
                    <div className="mb-2 text-[11px] text-muted-foreground/65">
                      {t('layoutManager.rawJson.description')}
                    </div>
                    <pre className="max-h-[260px] overflow-auto rounded-[8px] border border-border bg-secondary px-3 py-2 text-[11px] leading-[1.45] text-foreground/80 whitespace-pre-wrap break-all">
                      {rawOutputAvailable
                        ? rawOutputJson
                        : t('layoutManager.rawJson.empty')}
                    </pre>
                  </div>
                </details>
              </div>
            </div>
          )}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="vertical"
          className="flex touch-none select-none p-px transition-opacity duration-150 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 w-1.5"
        >
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-foreground/10 hover:bg-foreground/20 transition-colors" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  )
}
