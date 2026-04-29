import { Fragment, useMemo, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  Box,
  HStack,
  IconButton,
  ScrollArea,
  Text,
  VStack,
} from '@chakra-ui/react'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { ParamRenderer } from '@/features/devices/components/params/ParamRenderer'
import {
  useBridgeStore,
  type EffectParamDependency,
  type EffectParamInfo,
  type LocalizedText as BridgeLocalizedText,
} from '@/lib/bridge'
import { t, useLocale } from '@/lib/i18n'
import type { EffectParam, EffectParamValue, LocalizedText as UiLocalizedText, RangeSliderValue } from '@/types'

type VisibleParamEntry = {
  param: EffectParam
  value: EffectParamValue
  disabled: boolean
  groupLabel: string | null
  showGroup: boolean
}

function resolveLocalizedText(value: BridgeLocalizedText | undefined, locale: string): string {
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

function normalizeColor(value: unknown, fallback = '#ffffff') {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function normalizeRangeValue(param: { min?: number; max?: number; default?: unknown }, value: unknown): RangeSliderValue {
  const min = normalizeNumber(param.min, 0)
  const max = normalizeNumber(param.max, 100)
  const fallback = Array.isArray(param.default) ? param.default : [min, max]
  const raw = Array.isArray(value) ? value : fallback
  const start = Math.min(max, Math.max(min, normalizeNumber(raw[0], min)))
  const end = Math.min(max, Math.max(start, normalizeNumber(raw[1], max)))
  return [start, end]
}

function normalizeMultiColorValue(param: { default?: unknown }, value: unknown): string[] {
  const fallback = Array.isArray(param.default) ? param.default : ['#ffffff']
  const raw = Array.isArray(value) ? value : fallback
  const normalized = raw.map(color => normalizeColor(color)).filter(Boolean)
  return normalized.length > 0 ? normalized : ['#ffffff']
}

function normalizeLocalizedText(value: BridgeLocalizedText | undefined, fallback: string): UiLocalizedText {
  return {
    raw: value?.raw ?? fallback,
    byLocale: value?.byLocale,
  }
}

function normalizeDependency(dependency: EffectParamDependency | null | undefined): EffectParam['dependency'] {
  if (!dependency?.key) return undefined

  return {
    key: dependency.key,
    equals: typeof dependency.equals === 'number' ? dependency.equals : undefined,
    notEquals: typeof dependency.not_equals === 'number' ? dependency.not_equals : undefined,
    behavior: dependency.behavior,
  }
}

function normalizeEffectParamType(type: string) {
  if (type === 'range_slider') return 'range-slider'
  if (type === 'multi_color') return 'multi-color'
  return type
}

function normalizeEffectParam(param: EffectParamInfo): EffectParam | null {
  const type = normalizeEffectParamType(param.type)
  const label = normalizeLocalizedText(param.label, param.key)
  const group = param.group ? normalizeLocalizedText(param.group, '') : undefined
  const dependency = normalizeDependency(param.dependency)
  const base = { key: param.key, label, group, dependency }

  switch (type) {
    case 'slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      return {
        ...base,
        type,
        min,
        max,
        step: normalizeNumber(param.step, 1),
        default: normalizeNumber(param.default, min),
      }
    }

    case 'range-slider': {
      const min = normalizeNumber(param.min, 0)
      const max = normalizeNumber(param.max, 100)
      return {
        ...base,
        type,
        min,
        max,
        step: normalizeNumber(param.step, 1),
        default: normalizeRangeValue({ min, max, default: param.default }, param.default),
      }
    }

    case 'select': {
      const options = (param.options ?? []).map((option, index) => {
        const value = normalizeNumber(option.value, index)
        return {
          value,
          label: normalizeLocalizedText(option.label, String(value)),
        }
      })

      return {
        ...base,
        type,
        default: normalizeNumber(param.default, options[0]?.value ?? 0),
        options,
      }
    }

    case 'toggle':
      return {
        ...base,
        type,
        default: param.default === true,
      }

    case 'color':
      return {
        ...base,
        type,
        default: normalizeColor(param.default),
      }

    case 'multi-color':
      return {
        ...base,
        type,
        default: normalizeMultiColorValue(param, param.default),
        fixedCount: typeof param.fixedCount === 'number' ? param.fixedCount : undefined,
        minCount: typeof param.minCount === 'number' ? param.minCount : undefined,
        maxCount: typeof param.maxCount === 'number' ? param.maxCount : undefined,
      }

    default:
      return null
  }
}

function normalizeEffectParamValue(param: EffectParam, value: unknown): EffectParamValue {
  switch (param.type) {
    case 'slider':
      return Math.min(param.max, Math.max(param.min, normalizeNumber(value, param.default)))
    case 'range-slider':
      return normalizeRangeValue(param, value)
    case 'select':
      return normalizeNumber(value, param.default)
    case 'toggle':
      return value === true
    case 'color':
      return normalizeColor(value, param.default)
    case 'multi-color':
      return normalizeMultiColorValue(param, value)
  }
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
      <Box flexShrink={0} w="152px" maxW="56%" display="flex" justifyContent="flex-end" alignItems="center">
        {control}
      </Box>
    </HStack>
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

      const normalizedParam = normalizeEffectParam(param)
      if (!normalizedParam) return []

      const groupLabel = resolveLocalizedText(param.group, locale) || null
      const showGroup = groupLabel != null && groupLabel !== lastGroupLabel
      lastGroupLabel = groupLabel ?? lastGroupLabel

      return [{
        param: normalizedParam,
        value: normalizeEffectParamValue(normalizedParam, effectiveParams[param.key]),
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
                      <Switch
                        checked={activeLayout.virtual_device.power_on}
                        disabled={!isRegistered}
                        onChange={() => setVirtualDevicePower(
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
                      <Switch
                        checked={activeLayout.virtual_device.paused}
                        disabled={!isRegistered}
                        onChange={() => setVirtualDevicePaused(
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
                    <Select
                      value={activeLayout.virtual_device.effect_id ?? ''}
                      options={[
                        { value: '', label: t('layoutManager.effect.none') },
                        ...sortedEffects.map(effect => ({
                          value: effect.id,
                          label: resolveLocalizedText(effect.name, locale) || effect.id,
                        })),
                      ]}
                      onChange={effectId => setVirtualDeviceEffect(activeLayout.id, effectId || null)}
                      disabled={!isRegistered}
                    />
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
                  <Box display="flex" flexDirection="column" gap="4" px="3" pb="3">
                    {visibleParams.map(({ param, value, disabled, groupLabel, showGroup }) => (
                      <Fragment key={param.key}>
                        {showGroup && groupLabel ? (
                          <Text fontSize="10px" fontWeight="semibold" textTransform="uppercase" color="fg.muted" opacity={0.55}>
                            {groupLabel}
                          </Text>
                        ) : null}
                        <ParamRenderer
                          param={param}
                          value={value}
                          disabled={!isRegistered || disabled}
                          onChange={(nextValue) => {
                            updateVirtualDeviceEffectParams(activeLayout.id, {
                              ...effectiveParams,
                              [param.key]: nextValue,
                            })
                          }}
                          onCommit={(nextValue) => {
                            updateVirtualDeviceEffectParams(activeLayout.id, {
                              ...effectiveParams,
                              [param.key]: nextValue,
                            })
                          }}
                        />
                      </Fragment>
                    ))}
                  </Box>
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
