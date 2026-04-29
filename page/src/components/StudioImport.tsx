import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Check,
  ChevronRight,
  AlertTriangle,
  Loader2,
  FolderOpen,
  RefreshCw,
  ArrowLeft,
  ArrowRight,
  Download,
} from 'lucide-react'
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  NativeSelect,
  Portal,
  ScrollArea,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useBridgeStore } from '@/lib/bridge'
import type { TreeDevice } from '@/types'
import type {
  StudioTabInfo,
  StudioDeviceMatch,
  StudioZoneMatch,
  StudioResolvedMatch,
} from '@/types'
import { t, useLocale } from '@/lib/i18n'

type Step = 'select' | 'match' | 'leds' | 'confirm'

/* ── Resolved match state per zone ── */
interface ZoneResolution {
  deviceId: string
  outputId: string
  segmentId: string | null
}

/* ── Step 1: Tab Selection ── */
function TabSelectStep({
  tabs,
  onSelect,
  error,
  path,
}: {
  tabs: StudioTabInfo[]
  onSelect: (tab: StudioTabInfo) => void
  error?: string
  path?: string
}) {
  useLocale()

  if (error) {
    return (
      <VStack gap="3" py="8" textAlign="center">
        <FolderOpen size={40} color="var(--text-secondary)" opacity={0.35} />
        <Text textStyle="sm" color="fg.muted">{t('studioImport.noTabs')}</Text>
        {path && (
          <Text textStyle="xs" color="fg.muted" maxW="380px" wordBreak="break-all">
            {t('studioImport.noTabsHint').replace('{path}', path)}
          </Text>
        )}
      </VStack>
    )
  }

  return (
    <VStack align="stretch" gap="1">
      <Text textStyle="sm" color="fg.muted" mb="2">{t('studioImport.selectTab')}</Text>
      {tabs.map(tab => (
        <Button
          key={tab.tab_serial}
          variant="surface"
          justifyContent="space-between"
          h="auto"
          px="3"
          py="2.5"
          onClick={() => onSelect(tab)}
        >
          <Box flex="1" minW="0" textAlign="left">
            <Text textStyle="sm" fontWeight="medium" truncate>{tab.name}</Text>
            <Text textStyle="xs" color="fg.muted">
              {t('studioImport.zones').replace('{n}', String(tab.zones_count))}
              {tab.has_overrides && ` · ${t('studioImport.hasOverrides')}`}
            </Text>
          </Box>
          <ChevronRight size={16} />
        </Button>
      ))}
    </VStack>
  )
}

/* ── Step 2: Device/Zone Matching ── */
function DeviceMatchStep({
  tab,
  devices,
  resolutions,
  onDeviceChange,
  onOutputChange,
}: {
  tab: StudioTabInfo
  devices: TreeDevice[]
  resolutions: Map<string, ZoneResolution>
  onDeviceChange: (oldDeviceKey: string, newDeviceId: string) => void
  onOutputChange: (memberKey: string, outputId: string, segmentId: string | null) => void
}) {
  useLocale()

  return (
    <VStack align="stretch" gap="3">
      <Text textStyle="sm" color="fg.muted">{t('studioImport.matchDevices')}</Text>
      {tab.device_matches.map(dm => (
        <DeviceMatchBlock
          key={dm.old_device_key}
          dm={dm}
          devices={devices}
          resolutions={resolutions}
          onDeviceChange={onDeviceChange}
          onOutputChange={onOutputChange}
        />
      ))}
    </VStack>
  )
}

function DeviceMatchBlock({
  dm,
  devices,
  resolutions,
  onDeviceChange,
  onOutputChange,
}: {
  dm: StudioDeviceMatch
  devices: TreeDevice[]
  resolutions: Map<string, ZoneResolution>
  onDeviceChange: (oldDeviceKey: string, newDeviceId: string) => void
  onOutputChange: (memberKey: string, outputId: string, segmentId: string | null) => void
}) {
  useLocale()
  const [open, setOpen] = useState(true)

  // Find the currently selected device for this old device.
  // Check ALL zones (not just the first) — some zones may not have output matches yet.
  const currentDeviceId = useMemo(() => {
    for (const zone of dm.zones) {
      const res = resolutions.get(zone.member_key)
      if (res?.deviceId) return res.deviceId
    }
    return undefined
  }, [dm.zones, resolutions])
  const matchedDevice = currentDeviceId ? devices.find(d => d.id === currentDeviceId) : undefined
  const hasMatch = !!matchedDevice

  return (
    <Box rounded="var(--radius-m)" borderWidth="1px" borderColor="border.subtle" overflow="hidden">
      <HStack
        gap="2"
        px="3"
        py="2"
        bg="bg.subtle"
        cursor="pointer"
        transition="background 160ms ease"
        _hover={{ bg: 'bg.muted' }}
        onClick={() => setOpen(o => !o)}
      >
        <Box
          as={ChevronRight}
          boxSize="3.5"
          color="fg.muted"
          opacity={0.6}
          transition="transform 150ms ease"
          transform={open ? 'rotate(90deg)' : 'rotate(0deg)'}
        />
        <Box flex="1" minW="0">
          <Text textStyle="xs" fontWeight="medium" truncate>{dm.name}{dm.serial ? ` (${dm.serial})` : ''}</Text>
          <Text fontSize="10px" color="fg.muted" opacity={0.6} truncate>{dm.old_device_key}</Text>
        </Box>
        {hasMatch ? (
          <HStack gap="1" fontSize="10px" color="green.600" flexShrink={0}>
            <Box as={Check} boxSize="3" />
            {matchedDevice?.name ?? currentDeviceId}
          </HStack>
        ) : (
          <HStack gap="1" fontSize="10px" color="orange.500" flexShrink={0}>
            <Box as={AlertTriangle} boxSize="3" />
            {t('studioImport.noMatch')}
          </HStack>
        )}
      </HStack>

      {open && (
        <VStack align="stretch" gap="2" px="3" py="2">
          <HStack gap="2">
            <Text fontSize="11px" color="fg.muted" flexShrink={0}>{t('studioImport.newDevice')}:</Text>
            <NativeSelect.Root size="xs" flex="1">
              <NativeSelect.Field
                value={currentDeviceId ?? ''}
                onChange={e => onDeviceChange(dm.old_device_key, e.currentTarget.value)}
              >
                <option value="">{t('studioImport.selectDevice')}</option>
                {devices.map(d => (
                  <option key={d.id} value={d.id}>{d.name ?? d.id}{d.serial_id ? ` (${d.serial_id})` : ''}</option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>

          {matchedDevice && dm.zones.map(zone => (
            <ZoneMatchRow
              key={zone.member_key}
              zone={zone}
              device={matchedDevice}
              resolution={resolutions.get(zone.member_key)}
              onOutputChange={onOutputChange}
            />
          ))}
        </VStack>
      )}
    </Box>
  )
}

function ZoneMatchRow({
  zone,
  device,
  resolution,
  onOutputChange,
}: {
  zone: StudioZoneMatch
  device: TreeDevice
  resolution: ZoneResolution | undefined
  onOutputChange: (memberKey: string, outputId: string, segmentId: string | null) => void
}) {
  useLocale()
  const outputs = device.outputs

  const handleOutputChange = (outputId: string) => {
    const output = outputs.find(o => o.id === outputId)
    // Auto-assign segment if there's exactly one
    const segmentId = output?.segments?.length === 1 ? output.segments[0].id : null
    onOutputChange(zone.member_key, outputId, segmentId)
  }

  const handleSegmentChange = (segmentId: string) => {
    if (resolution) {
      onOutputChange(zone.member_key, resolution.outputId, segmentId || null)
    }
  }

  const matchedOutput = resolution ? outputs.find(o => o.id === resolution.outputId) : undefined
  const segments = matchedOutput?.segments ?? []

  return (
    <Box pl="4" borderLeftWidth="2px" borderColor="border.subtle" ml="1">
      <HStack gap="2" flexWrap="wrap">
        <Text fontSize="10px" color="fg.muted" opacity={0.7} flexShrink={0}>{zone.zone_name}</Text>
        <Text fontSize="10px" color="fg.muted" opacity={0.4}>→</Text>
        <NativeSelect.Root size="xs" minW="120px" w="auto">
          <NativeSelect.Field
            value={resolution?.outputId ?? ''}
            onChange={e => handleOutputChange(e.currentTarget.value)}
          >
            <option value="">{t('studioImport.selectOutput')}</option>
            {outputs.map(o => (
              <option key={o.id} value={o.id}>{o.name ?? o.id} ({o.leds_count ?? '?'})</option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>

        {/* Segment selector (only if output has multiple segments) */}
        {segments.length > 1 && (
          <NativeSelect.Root size="xs" minW="100px" w="auto">
            <NativeSelect.Field
              value={resolution?.segmentId ?? ''}
              onChange={e => handleSegmentChange(e.currentTarget.value)}
            >
              <option value="">{t('studioImport.segment')}...</option>
              {segments.map(s => (
                <option key={s.id} value={s.id}>{s.name ?? s.id} ({s.leds_count ?? '?'})</option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        )}

        {/* LED count mismatch indicator */}
        {zone.old_leds_count > 0 && zone.new_leds_count > 0 && zone.old_leds_count !== zone.new_leds_count && (
          <HStack gap="1" fontSize="10px" color="orange.500">
            <Box as={AlertTriangle} boxSize="3" />
            {t('studioImport.ledMismatch.expected').replace('{expected}', String(zone.old_leds_count)).replace('{actual}', String(zone.new_leds_count))}
          </HStack>
        )}
      </HStack>
    </Box>
  )
}

/* ── Step 3: LED Mismatch Guidance ── */
function LedMismatchStep({
  mismatches,
  onRefresh,
  refreshing,
}: {
  mismatches: Array<{
    zoneName: string
    deviceName: string
    deviceId: string
    outputName: string
    outputCount: number
    oldCount: number
    newCount: number
    memberKey: string
  }>
  onRefresh: () => void
  refreshing: boolean
}) {
  useLocale()

  const resolved = mismatches.length === 0

  // Group mismatches by deviceId
  const grouped = useMemo(() => {
    const map = new Map<string, {
      deviceName: string
      items: Array<{ outputName: string; oldCount: number; newCount: number; outputCount: number }>
    }>()
    for (const m of mismatches) {
      let entry = map.get(m.deviceId)
      if (!entry) {
        entry = { deviceName: m.deviceName, items: [] }
        map.set(m.deviceId, entry)
      }
      entry.items.push({
        outputName: m.outputName,
        oldCount: m.oldCount,
        newCount: m.newCount,
        outputCount: m.outputCount,
      })
    }
    return [...map.values()]
  }, [mismatches])

  return (
    <VStack align="stretch" gap="4">
      {resolved ? (
        <Box rounded="var(--radius-m)" borderWidth="1px" borderColor="green.500/30" bg="green.500/5" p="4">
          <HStack align="start" gap="2">
            <Box as={Check} boxSize="5" color="green.600" flexShrink={0} mt="0.5" />
            <Box>
              <Text textStyle="sm" fontWeight="medium" color="green.600">{t('studioImport.ledMismatch.resolved.title')}</Text>
              <Text mt="1" textStyle="xs" color="fg.muted">{t('studioImport.ledMismatch.resolved.guide')}</Text>
            </Box>
          </HStack>
        </Box>
      ) : (
        <>
          <Box rounded="var(--radius-m)" borderWidth="1px" borderColor="orange.500/30" bg="orange.500/5" p="4">
            <HStack align="start" gap="2">
              <Box as={AlertTriangle} boxSize="5" color="orange.500" flexShrink={0} mt="0.5" />
              <Box>
                <Text textStyle="sm" fontWeight="medium" color="orange.600">{t('studioImport.ledMismatch.title')}</Text>
                <Text mt="1" textStyle="xs" color="fg.muted">{t('studioImport.ledMismatch.guide')}</Text>
              </Box>
            </HStack>
          </Box>

          <VStack align="stretch" gap="3">
            {grouped.map((group, gi) => (
              <Box key={gi} rounded="var(--radius-m)" borderWidth="1px" borderColor="border.subtle" px="3" py="2.5">
                <Text textStyle="xs" fontWeight="medium">{group.deviceName}</Text>
                <VStack align="stretch" gap="1" mt="1.5">
                  {group.items.map((item, ii) => {
                    const adjustText = t('studioImport.ledMismatch.adjustLeds')
                      .replace('{from}', String(item.newCount))
                      .replace('{to}', String(item.oldCount))
                    return (
                      <Text key={ii} textStyle="xs" color="fg.muted" pl="3">
                        {item.outputCount > 1 ? (
                          <><Text as="span" color="fg" opacity={0.7}>"{item.outputName}"</Text> {adjustText}</>
                        ) : (
                          adjustText
                        )}
                      </Text>
                    )
                  })}
                </VStack>
              </Box>
            ))}
          </VStack>

          <VStack align="stretch" gap="2" textStyle="xs" color="fg.muted">
            <Text fontWeight="medium" color="fg" opacity={0.8}>{t('studioImport.ledMismatch.stepsTitle')}</Text>
            <Box as="ol" listStyleType="decimal" pl="4">
              <Box as="li">{t('studioImport.ledMismatch.step1')}</Box>
              <Box as="li">{t('studioImport.ledMismatch.step2')}</Box>
              <Box as="li">{t('studioImport.ledMismatch.step3')}</Box>
            </Box>
          </VStack>
        </>
      )}

      <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} alignSelf="flex-start">
        <Box as={RefreshCw} boxSize="3.5" mr="1.5" animation={refreshing ? 'spin 1s linear infinite' : undefined} />
        {t('studioImport.ledMismatch.refresh')}
      </Button>
    </VStack>
  )
}

/* ── Main Dialog ── */
export function StudioImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const [step, setStep] = useState<Step>('select')
  const [selectedTab, setSelectedTab] = useState<StudioTabInfo | null>(null)
  const [resolutions, setResolutions] = useState<Map<string, ZoneResolution>>(new Map())
  const [layoutName, setLayoutName] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [importing, setImporting] = useState(false)

  const scanResult = useBridgeStore(s => s.studioScanResult)
  const importResult = useBridgeStore(s => s.studioImportResult)
  const devices = useBridgeStore(s => s.devices)
  const scanStudioTabs = useBridgeStore(s => s.scanStudioTabs)
  const importStudioTab = useBridgeStore(s => s.importStudioTab)
  const clearStudioResults = useBridgeStore(s => s.clearStudioResults)

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep('select')
      setSelectedTab(null)
      setResolutions(new Map())
      setLayoutName('')
      setImporting(false)
      setRefreshing(false)
      scanStudioTabs()
    } else {
      clearStudioResults()
    }
  }, [open, scanStudioTabs, clearStudioResults])

  // Handle import result
  useEffect(() => {
    if (importResult) {
      setImporting(false)
      if (importResult.success) {
        onOpenChange(false)
      }
    }
  }, [importResult, onOpenChange])

  // Handle scan result update (for refresh)
  useEffect(() => {
    if (scanResult && refreshing) {
      setRefreshing(false)
      // Update selected tab from refreshed data
      if (selectedTab) {
        const updated = scanResult.tabs.find(t => t.tab_serial === selectedTab.tab_serial)
        if (updated) {
          setSelectedTab(updated)
          initResolutions(updated)
        }
      }
    }
  }, [scanResult, refreshing, selectedTab])

  // Initialize resolutions from auto-matched data
  const initResolutions = useCallback((tab: StudioTabInfo) => {
    const map = new Map<string, ZoneResolution>()
    for (const dm of tab.device_matches) {
      if (!dm.auto_match) continue
      for (const zone of dm.zones) {
        if (zone.auto_match_output) {
          map.set(zone.member_key, {
            deviceId: dm.auto_match.device_id,
            outputId: zone.auto_match_output.output_id,
            segmentId: zone.auto_match_output.segment_id,
          })
        }
      }
    }
    setResolutions(map)
  }, [])

  const handleTabSelect = useCallback((tab: StudioTabInfo) => {
    setSelectedTab(tab)
    setLayoutName(tab.name)
    initResolutions(tab)
    setStep('match')
  }, [initResolutions])

  const handleDeviceChange = useCallback((oldDeviceKey: string, newDeviceId: string) => {
    if (!selectedTab) return
    setResolutions(prev => {
      const next = new Map(prev)
      // Find all zones for this old device
      const dm = selectedTab.device_matches.find(d => d.old_device_key === oldDeviceKey)
      if (!dm) return next

      const device = devices.find(d => d.id === newDeviceId)

      for (const zone of dm.zones) {
        if (!newDeviceId || !device) {
          next.delete(zone.member_key)
          continue
        }
        // Try auto-matching output for this device
        const outputs = device.outputs ?? []
        let outputId = ''
        let segmentId: string | null = null

        if (outputs.length === 1) {
          outputId = outputs[0].id
          if (outputs[0].segments.length === 1) {
            segmentId = outputs[0].segments[0].id
          }
        } else {
          // Try name matching
          const zoneLower = zone.zone_name.toLowerCase()
          for (const o of outputs) {
            const oName = (o.name ?? '').toLowerCase()
            if (oName === zoneLower || oName.includes(zoneLower) || zoneLower.includes(oName)) {
              outputId = o.id
              if (o.segments.length === 1) segmentId = o.segments[0].id
              break
            }
          }
        }

        // Always store the device selection so the user can manually pick outputs.
        // Use a placeholder outputId='' when auto-matching fails — the zone rows
        // will show the output dropdown for the user to fill in.
        next.set(zone.member_key, { deviceId: newDeviceId, outputId, segmentId })
      }
      return next
    })
  }, [selectedTab, devices])

  const handleOutputChange = useCallback((memberKey: string, outputId: string, segmentId: string | null) => {
    setResolutions(prev => {
      const next = new Map(prev)
      const existing = next.get(memberKey)
      if (!outputId) {
        next.delete(memberKey)
      } else if (existing) {
        next.set(memberKey, { ...existing, outputId, segmentId })
      }
      return next
    })
  }, [])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    scanStudioTabs()
  }, [scanStudioTabs])

  // Compute LED mismatches
  const ledMismatches = useMemo(() => {
    if (!selectedTab) return []
    const mismatches: Array<{
      zoneName: string
      deviceName: string
      deviceId: string
      outputName: string
      outputCount: number
      oldCount: number
      newCount: number
      memberKey: string
    }> = []

    for (const dm of selectedTab.device_matches) {
      for (const zone of dm.zones) {
        const res = resolutions.get(zone.member_key)
        if (!res) continue

        // Find device and output to get current LED count
        const device = devices.find(d => d.id === res.deviceId)
        if (!device) continue

        const output = device.outputs.find(o => o.id === res.outputId)
        if (!output) continue

        let currentLeds = output.leds_count ?? 0
        if (res.segmentId) {
          const seg = output.segments.find(s => s.id === res.segmentId)
          if (seg) currentLeds = seg.leds_count ?? 0
        }

        // Count how many outputs/segments are resolved for this device
        const deviceOutputCount = dm.zones.filter(z => {
          const r = resolutions.get(z.member_key)
          return r && r.deviceId === res.deviceId && r.outputId
        }).length

        if (zone.old_leds_count > 0 && currentLeds > 0 && zone.old_leds_count !== currentLeds) {
          mismatches.push({
            zoneName: zone.zone_name,
            deviceName: device.name ?? device.id,
            deviceId: res.deviceId,
            outputName: output.name ?? output.id,
            outputCount: deviceOutputCount,
            oldCount: zone.old_leds_count,
            newCount: currentLeds,
            memberKey: zone.member_key,
          })
        }
      }
    }
    return mismatches
  }, [selectedTab, resolutions, devices])

  // Only count zones with both deviceId AND outputId as resolved
  const resolvedCount = useMemo(() => {
    let count = 0
    for (const res of resolutions.values()) {
      if (res.deviceId && res.outputId) count++
    }
    return count
  }, [resolutions])
  const totalZones = selectedTab?.device_matches.reduce((sum, dm) => sum + dm.zones.length, 0) ?? 0
  const skippedCount = totalZones - resolvedCount

  const handleNextFromMatch = useCallback(() => {
    if (ledMismatches.length > 0) {
      setStep('leds')
    } else {
      setStep('confirm')
    }
  }, [ledMismatches])

  const handleImport = useCallback(() => {
    if (!selectedTab) return
    setImporting(true)

    const resolved: StudioResolvedMatch[] = []
    for (const [memberKey, res] of resolutions) {
      // Only include zones with both deviceId and outputId resolved
      if (!res.deviceId || !res.outputId) continue
      resolved.push({
        member_key: memberKey,
        device_id: res.deviceId,
        output_id: res.outputId,
        segment_id: res.segmentId,
      })
    }

    importStudioTab(selectedTab.tab_serial, layoutName || selectedTab.name, resolved)
  }, [selectedTab, resolutions, layoutName, importStudioTab])

  const isLoading = !scanResult

  return (
    <Dialog.Root open={open} onOpenChange={e => onOpenChange(e.open)} placement="center" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="2xl" maxH="85vh" bg="bg.panel" borderColor="border" boxShadow="var(--shadow-dialog)">
            <Dialog.Header>
              <Dialog.Title>{t('studioImport.title')}</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <ScrollArea.Root maxH="50vh" overflow="hidden" size="xs">
                <ScrollArea.Viewport h="full">
                  <ScrollArea.Content pe="2">
                    {isLoading && (
                      <HStack justify="center" gap="2" py="12">
                        <Box as={Loader2} boxSize="5" color="fg.muted" animation="spin 1s linear infinite" />
                        <Text textStyle="sm" color="fg.muted">{t('studioImport.scanning')}</Text>
                      </HStack>
                    )}

            {!isLoading && step === 'select' && (
              <TabSelectStep
                tabs={scanResult.tabs}
                onSelect={handleTabSelect}
                error={scanResult.error}
                path={scanResult.path}
              />
            )}

            {!isLoading && step === 'match' && selectedTab && (
              <DeviceMatchStep
                tab={selectedTab}
                devices={devices}
                resolutions={resolutions}
                onDeviceChange={handleDeviceChange}
                onOutputChange={handleOutputChange}
              />
            )}

            {!isLoading && step === 'leds' && (
              <LedMismatchStep
                mismatches={ledMismatches}
                onRefresh={handleRefresh}
                refreshing={refreshing}
              />
            )}

                    {!isLoading && step === 'confirm' && (
              <VStack align="stretch" gap="4">
                <VStack align="stretch" gap="2">
                  <Text as="label" textStyle="xs" color="fg.muted">{t('studioImport.layoutName')}</Text>
                  <Input
                    type="text"
                    size="sm"
                    value={layoutName}
                    onChange={e => setLayoutName(e.target.value)}
                    maxLength={64}
                  />
                </VStack>
                <HStack gap="4" textStyle="xs" color="fg.muted">
                  <Text>{t('studioImport.placements').replace('{n}', String(resolvedCount))}</Text>
                  {skippedCount > 0 && (
                    <Text color="orange.500">
                      {t('studioImport.skipUnmatched')} ({skippedCount})
                    </Text>
                  )}
                </HStack>

                {importResult && !importResult.success && (
                  <Box rounded="var(--radius-m)" borderWidth="1px" borderColor="red.500/30" bg="red.500/5" p="3" textStyle="xs" color="red.600">
                    {t('studioImport.error')}: {importResult.error ?? importResult.detail ?? 'unknown'}
                  </Box>
                )}
              </VStack>
            )}
                  </ScrollArea.Content>
                </ScrollArea.Viewport>
                <ScrollArea.Scrollbar orientation="vertical">
                  <ScrollArea.Thumb />
                </ScrollArea.Scrollbar>
              </ScrollArea.Root>
            </Dialog.Body>

        <Dialog.Footer>
          {step !== 'select' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (step === 'match') setStep('select')
                else if (step === 'leds') setStep('match')
                else if (step === 'confirm') setStep(ledMismatches.length > 0 ? 'leds' : 'match')
              }}
            >
              <Box as={ArrowLeft} boxSize="3.5" mr="1" />
              {t('studioImport.back')}
            </Button>
          )}
          <Box flex="1" />
          {step === 'match' && (
            <Button size="sm" onClick={handleNextFromMatch} disabled={resolvedCount === 0}>
              {t('studioImport.next')}
              <Box as={ArrowRight} boxSize="3.5" ml="1" />
            </Button>
          )}
          {step === 'leds' && (
            ledMismatches.length === 0 ? (
              <Button size="sm" onClick={() => setStep('confirm')}>
                {t('studioImport.next')}
                <Box as={ArrowRight} boxSize="3.5" ml="1" />
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep('confirm')}
              >
                {t('studioImport.ledMismatch.forceImport')}
              </Button>
            )
          )}
          {step === 'confirm' && (
            <Button size="sm" onClick={handleImport} disabled={importing || resolvedCount === 0}>
              {importing ? (
                <Box as={Loader2} boxSize="3.5" mr="1" animation="spin 1s linear infinite" />
              ) : (
                <Box as={Download} boxSize="3.5" mr="1" />
              )}
              {t('studioImport.import')}
            </Button>
          )}
        </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
