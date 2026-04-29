import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  ScrollArea,
  Slider,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react'
import {
  useBridgeStore,
  type EffectInfo,
  type EffectParamDependency,
  type EffectParamInfo,
  type LocalizedText,
} from '@/lib/bridge'
import { t, useLocale } from '@/lib/i18n'

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

function buildEffectiveParams(
  schema: EffectParamInfo[],
  current: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current }
  for (const param of schema) {
    if (!(param.key in next) && param.default !== undefined) {
      next[param.key] = cloneValue(param.default)
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
  const normalized = raw.map(color => normalizeColor(color)).filter(Boolean)
  return normalized.length > 0 ? normalized : ['#ffffff']
}

function serializeOptionValue(value: unknown) {
  return JSON.stringify(value) ?? String(value)
}

function parseOptionValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
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
    <Switch.Root
      disabled={disabled}
      checked={checked}
      size="sm"
      onCheckedChange={onToggle}
    >
      <Switch.HiddenInput />
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
      <Switch.Label />
    </Switch.Root>
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
    <HStack
      gap="3"
      px="3"
      py="2.5"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      opacity={disabled ? 0.55 : 1}
      _last={{ borderBottomWidth: 0 }}
    >
      <Box minW="0" flex="1">
        <Text textStyle="xs" color="fg">{label}</Text>
        {hint ? (
          <Text mt="0.5" textStyle="2xs" color="fg.muted">
            {hint}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0} w="152px" maxW="56%">
        {control}
      </Box>
    </HStack>
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
  const syncedValue = useMemo(() => cloneValue(value), [value])
  const [draftValue, setDraftValue] = useState<unknown>(() => syncedValue)
  const [isInteracting, setIsInteracting] = useState(false)
  const resolvedValue = isInteracting ? draftValue : syncedValue
  const draftValueRef = useRef(resolvedValue)
  const lastCommittedValueRef = useRef<unknown>(syncedValue)

  useEffect(() => {
    draftValueRef.current = resolvedValue
  }, [resolvedValue])

  useEffect(() => {
    lastCommittedValueRef.current = syncedValue
  }, [syncedValue])

  const startInteraction = useCallback(() => {
    setDraftValue(cloneValue(syncedValue))
    setIsInteracting(true)
  }, [syncedValue])

  const commitDeferredValue = useCallback((nextValue?: unknown) => {
    const resolvedValue = cloneValue(nextValue ?? draftValueRef.current)
    setIsInteracting(false)
    setDraftValue(resolvedValue)

    if (JSON.stringify(resolvedValue) === JSON.stringify(lastCommittedValueRef.current)) {
      return
    }

    lastCommittedValueRef.current = cloneValue(resolvedValue)
    onChange(resolvedValue)
  }, [onChange])

  // Toggle type uses horizontal BasicSettingRow layout
  if (param.type === 'toggle') {
    return (
      <BasicSettingRow
        label={label}
        disabled={disabled}
        control={(
          <HStack justify="flex-end">
            <SettingSwitch
              checked={value === true}
              disabled={disabled}
              onToggle={() => onChange(value !== true)}
            />
          </HStack>
        )}
      />
    )
  }

  let control: React.ReactNode = null

  switch (param.type) {
    case 'slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      const step = normalizeNumber(param.step, 1)
      const numericValue = Math.min(max, Math.max(min, normalizeNumber(resolvedValue, min)))
      control = (
        <HStack gap="2">
          <Slider.Root
            flex="1"
            min={min}
            max={max}
            step={step}
            value={[numericValue]}
            disabled={disabled}
            aria-label={[label]}
            onPointerDown={startInteraction}
            onValueChange={e => {
              setIsInteracting(true)
              setDraftValue(e.value[0])
            }}
            onValueChangeEnd={e => {
              commitDeferredValue(e.value[0])
            }}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <Text w="52px" flexShrink={0} textAlign="right" textStyle="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
            {formatNumber(numericValue, step)}
          </Text>
        </HStack>
      )
      break
    }

    case 'range_slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      const step = normalizeNumber(param.step, 1)
      const [start, end] = normalizeRangeValue(param, resolvedValue)

      control = (
        <VStack align="stretch" gap="2">
          <Slider.Root
            min={min}
            max={max}
            step={step}
            value={[start, end]}
            disabled={disabled}
            aria-label={[t('layoutManager.rangeMin'), t('layoutManager.rangeMax')]}
            onPointerDown={startInteraction}
            onValueChange={e => {
              setIsInteracting(true)
              setDraftValue(e.value)
            }}
            onValueChangeEnd={e => {
              commitDeferredValue(e.value)
            }}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <HStack justify="space-between" textStyle="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
            <Text>{t('layoutManager.rangeMin')}: {formatNumber(start, step)}</Text>
            <Text>{t('layoutManager.rangeMax')}: {formatNumber(end, step)}</Text>
          </HStack>
        </VStack>
      )
      break
    }

    case 'select': {
      const options = Array.isArray(param.options) ? param.options : []
      const currentValue = serializeOptionValue(value)
      control = (
        <NativeSelect.Root size="sm" disabled={disabled}>
          <NativeSelect.Field
            value={currentValue}
            onChange={e => onChange(parseOptionValue(e.currentTarget.value))}
          >
            {options.map((option, index) => (
              <option key={`${param.key}-${index}`} value={serializeOptionValue(option.value)}>
                {resolveLocalizedText(option.label, locale) || String(option.value)}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      )
      break
    }

    case 'color': {
      const color = normalizeColor(value)
      control = (
        <HStack gap="2">
          <Input
            type="color"
            h="32px"
            w="44px"
            p="1"
            value={color}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
          />
          <Box flex="1" rounded="var(--radius-m)" borderWidth="1px" borderColor="border" bg="bg.muted" px="2" py="1.5">
            <Text textStyle="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
            {color.toUpperCase()}
            </Text>
          </Box>
        </HStack>
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
        <VStack align="stretch" gap="2">
          {colors.map((color, index) => (
            <HStack key={`${param.key}-${index}`} gap="2">
              <Input
                type="color"
                h="32px"
                w="44px"
                p="1"
                value={color}
                disabled={disabled}
                onChange={e => {
                  const next = [...colors]
                  next[index] = e.target.value
                  onChange(next)
                }}
              />
              <Box flex="1" rounded="var(--radius-m)" borderWidth="1px" borderColor="border" bg="bg.muted" px="2" py="1.5">
                <Text textStyle="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
                  {color.toUpperCase()}
                </Text>
              </Box>
              <IconButton
                aria-label={t('layoutManager.removeColor')}
                size="xs"
                variant="surface"
                disabled={!canRemove(colors.length)}
                onClick={() => {
                  const next = colors.filter((_, colorIndex) => colorIndex !== index)
                  onChange(next)
                }}
                title={t('layoutManager.removeColor')}
              >
                <X size={14} />
              </IconButton>
            </HStack>
          ))}
          {canAdd ? (
            <Button
              h="30px"
              size="xs"
              variant="outline"
              borderStyle="dashed"
              onClick={() => onChange([...colors, '#ffffff'])}
            >
              <Plus size={12} />
              {t('layoutManager.addColor')}
            </Button>
          ) : null}
        </VStack>
      )
      break
    }

    default: {
      control = (
        <Box rounded="var(--radius-m)" borderWidth="1px" borderStyle="dashed" borderColor="border" bg="bg.muted" px="2" py="1.5">
          <Text textStyle="2xs" color="fg.muted">{t('layoutManager.unsupported')}</Text>
        </Box>
      )
    }
  }

  return (
    <Box px="3" py="2.5" opacity={disabled ? 0.65 : 1}>
      <Text mb="2" textStyle="xs" color="fg">{label}</Text>
      {control}
    </Box>
  )
}

export function LayoutManager() {
  const locale = useLocale()
  const effects = useBridgeStore(s => s.effects)
  const layouts = useBridgeStore(s => s.layouts)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)
  const setVirtualDevicePower = useBridgeStore(s => s.setVirtualDevicePower)
  const setVirtualDevicePaused = useBridgeStore(s => s.setVirtualDevicePaused)
  const setVirtualDeviceEffect = useBridgeStore(s => s.setVirtualDeviceEffect)
  const updateVirtualDeviceEffectParams = useBridgeStore(s => s.updateVirtualDeviceEffectParams)
  const resetVirtualDeviceEffectParams = useBridgeStore(s => s.resetVirtualDeviceEffectParams)

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

  const isRegistered = activeLayout?.registered === true
  const panelStatusTitle = isRegistered
    ? t('layoutManager.status.registered')
    : t('layoutManager.status.unregistered')

  return (
    <VStack align="stretch" gap="0" h="full">
      <HStack gap="2" px="3" h="36px" borderBottomWidth="1px" borderColor="border.subtle" flexShrink={0}>
        <Text textStyle="2xs" fontWeight="semibold" textTransform="uppercase" color="fg.muted" flex="1">
          {t('layoutManager.panel')}
        </Text>
        <Box boxSize="1.5" rounded="full" flexShrink={0} bg={isRegistered ? 'green.500' : 'fg.muted'} opacity={isRegistered ? 1 : 0.25} title={panelStatusTitle} />
      </HStack>

      <ScrollArea.Root flex="1" overflow="hidden" size="xs">
        <ScrollArea.Viewport h="full" w="full">
          <ScrollArea.Content>
          {!activeLayout ? (
            <HStack justify="center" h="full" minH="80px">
              <Text textStyle="xs" color="fg.muted" opacity={0.4}>
                {t('layoutManager.noLayout')}
              </Text>
            </HStack>
          ) : (
            <Box py="1">
              <Box mx="1" rounded="var(--radius-s)" overflow="hidden" borderWidth="1px" borderColor="border.subtle" bg="bg.subtle">
                <BasicSettingRow
                  label={t('layoutManager.power')}
                  disabled={!isRegistered}
                  control={(
                    <HStack justify="flex-end">
                      <SettingSwitch
                        checked={activeLayout.virtual_device.power_on}
                        disabled={!isRegistered}
                        onToggle={() => setVirtualDevicePower(
                          activeLayout.id,
                          !activeLayout.virtual_device.power_on,
                        )}
                      />
                    </HStack>
                  )}
                />
                <BasicSettingRow
                  label={t('layoutManager.paused')}
                  disabled={!isRegistered}
                  control={(
                    <HStack justify="flex-end">
                      <SettingSwitch
                        checked={activeLayout.virtual_device.paused}
                        disabled={!isRegistered}
                        onToggle={() => setVirtualDevicePaused(
                          activeLayout.id,
                          !activeLayout.virtual_device.paused,
                        )}
                      />
                    </HStack>
                  )}
                />
                <BasicSettingRow
                  label={t('layoutManager.effect')}
                  disabled={!isRegistered}
                  control={(
                    <NativeSelect.Root size="sm" disabled={!isRegistered}>
                      <NativeSelect.Field
                        value={activeLayout.virtual_device.effect_id ?? ''}
                        onChange={e => setVirtualDeviceEffect(activeLayout.id, e.currentTarget.value || null)}
                      >
                        <option value="">{t('layoutManager.effect.none')}</option>
                        {sortedEffects.map((effect: EffectInfo) => (
                          <option key={effect.id} value={effect.id}>
                            {resolveLocalizedText(effect.name, locale) || effect.id}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  )}
                />
              </Box>

              <Box
                mx="1"
                mt="2"
                rounded="var(--radius-s)"
                overflow="hidden"
                borderWidth="1px"
                borderColor="border.subtle"
                bg="bg.subtle"
                opacity={isRegistered ? 1 : 0.55}
              >
                <HStack gap="2" px="3" py="2">
                  <Text textStyle="2xs" fontWeight="semibold" textTransform="uppercase" color="fg.muted" flex="1">
                    {t('layoutManager.effectSettings')}
                  </Text>
                  {selectedEffect ? (
                    <IconButton
                      aria-label={t('layoutManager.reset')}
                      size="2xs"
                      variant="ghost"
                      disabled={!isRegistered}
                      onClick={() => resetVirtualDeviceEffectParams(activeLayout.id)}
                      title={t('layoutManager.reset')}
                    >
                      <RotateCcw size={12} />
                    </IconButton>
                  ) : null}
                </HStack>

                {!selectedEffect ? (
                  <Text px="3" pb="3" textStyle="xs" color="fg.muted" opacity={0.55}>
                    {sortedEffects.length === 0
                      ? t('layoutManager.noEffects')
                      : t('layoutManager.noEffectSelected')}
                  </Text>
                ) : visibleParams.length === 0 ? (
                  <Text px="3" pb="3" textStyle="xs" color="fg.muted" opacity={0.55}>
                    {t('layoutManager.noSettings')}
                  </Text>
                ) : (
                  visibleParams.map(({ param, disabled, groupLabel, showGroup }) => (
                    <Fragment key={param.key}>
                      {showGroup && groupLabel ? (
                        <Text px="3" pt="3" pb="1" fontSize="10px" fontWeight="semibold" textTransform="uppercase" color="fg.muted" opacity={0.55}>
                          {groupLabel}
                        </Text>
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
              </Box>
            </Box>
          )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </VStack>
  )
}
