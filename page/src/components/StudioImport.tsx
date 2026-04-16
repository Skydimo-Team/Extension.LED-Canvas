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
import { ScrollArea } from 'radix-ui'
import { useBridgeStore } from '@/lib/bridge'
import type { TreeDevice } from '@/types'
import type {
  StudioTabInfo,
  StudioDeviceMatch,
  StudioZoneMatch,
  StudioResolvedMatch,
} from '@/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <FolderOpen className="size-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t('studioImport.noTabs')}</p>
        {path && (
          <p className="text-xs text-muted-foreground/60 max-w-[380px] break-all">
            {t('studioImport.noTabsHint').replace('{path}', path)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground mb-2">{t('studioImport.selectTab')}</p>
      {tabs.map(tab => (
        <button
          key={tab.tab_serial}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border border-border/50 hover:bg-accent/50 cursor-pointer transition-colors text-left"
          onClick={() => onSelect(tab)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{tab.name}</p>
            <p className="text-xs text-muted-foreground">
              {t('studioImport.zones').replace('{n}', String(tab.zones_count))}
              {tab.has_overrides && ` · ${t('studioImport.hasOverrides')}`}
            </p>
          </div>
          <ChevronRight className="size-4 text-muted-foreground/50 shrink-0" />
        </button>
      ))}
    </div>
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
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('studioImport.matchDevices')}</p>
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
    </div>
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
    <div className="rounded-lg border border-border/60 overflow-hidden">
      {/* Device header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <ChevronRight className={cn('size-3.5 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{dm.name}{dm.serial ? ` (${dm.serial})` : ''}</p>
          <p className="text-[10px] text-muted-foreground/60 truncate">{dm.old_device_key}</p>
        </div>
        {hasMatch ? (
          <span className="flex items-center gap-1 text-[10px] text-green-600 shrink-0">
            <Check className="size-3" />
            {matchedDevice?.name ?? currentDeviceId}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-orange-500 shrink-0">
            <AlertTriangle className="size-3" />
            {t('studioImport.noMatch')}
          </span>
        )}
      </div>

      {open && (
        <div className="px-3 py-2 space-y-2">
          {/* Device selector */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground shrink-0">{t('studioImport.newDevice')}:</span>
            <select
              className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              value={currentDeviceId ?? ''}
              onChange={e => onDeviceChange(dm.old_device_key, e.target.value)}
            >
              <option value="">{t('studioImport.selectDevice')}</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.name ?? d.id}{d.serial_id ? ` (${d.serial_id})` : ''}</option>
              ))}
            </select>
          </div>

          {/* Zone-Output mapping */}
          {matchedDevice && dm.zones.map(zone => (
            <ZoneMatchRow
              key={zone.member_key}
              zone={zone}
              device={matchedDevice}
              resolution={resolutions.get(zone.member_key)}
              onOutputChange={onOutputChange}
            />
          ))}
        </div>
      )}
    </div>
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
    <div className="pl-4 border-l-2 border-border/30 ml-1 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground/70 shrink-0">{zone.zone_name}</span>
        <span className="text-[10px] text-muted-foreground/40">→</span>
        <select
          className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-ring min-w-[120px]"
          value={resolution?.outputId ?? ''}
          onChange={e => handleOutputChange(e.target.value)}
        >
          <option value="">{t('studioImport.selectOutput')}</option>
          {outputs.map(o => (
            <option key={o.id} value={o.id}>{o.name ?? o.id} ({o.leds_count ?? '?'})</option>
          ))}
        </select>

        {/* Segment selector (only if output has multiple segments) */}
        {segments.length > 1 && (
          <select
            className="h-6 rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-ring min-w-[100px]"
            value={resolution?.segmentId ?? ''}
            onChange={e => handleSegmentChange(e.target.value)}
          >
            <option value="">{t('studioImport.segment')}...</option>
            {segments.map(s => (
              <option key={s.id} value={s.id}>{s.name ?? s.id} ({s.leds_count ?? '?'})</option>
            ))}
          </select>
        )}

        {/* LED count mismatch indicator */}
        {zone.old_leds_count > 0 && zone.new_leds_count > 0 && zone.old_leds_count !== zone.new_leds_count && (
          <span className="flex items-center gap-1 text-[10px] text-orange-500">
            <AlertTriangle className="size-3" />
            {zone.old_leds_count} → {zone.new_leds_count}
          </span>
        )}
      </div>
    </div>
  )
}

/* ── Step 3: LED Mismatch Guidance ── */
function LedMismatchStep({
  mismatches,
  onRefresh,
  refreshing,
}: {
  mismatches: Array<{ zoneName: string; deviceName: string; oldCount: number; newCount: number }>
  onRefresh: () => void
  refreshing: boolean
}) {
  useLocale()

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-orange-600">{t('studioImport.ledMismatch.title')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('studioImport.ledMismatch.guide')}</p>
          </div>
        </div>
      </div>

      {/* Mismatch table */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <div className="grid grid-cols-[1fr_1fr_60px_60px] gap-2 px-3 py-1.5 bg-muted/30 text-[10px] text-muted-foreground font-medium">
          <span>{t('studioImport.newDevice')}</span>
          <span>{t('studioImport.zone')}</span>
          <span className="text-right">Studio</span>
          <span className="text-right">{t('studioImport.ledCount')}</span>
        </div>
        {mismatches.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_60px_60px] gap-2 px-3 py-1.5 text-xs border-t border-border/30">
            <span className="truncate">{m.deviceName}</span>
            <span className="truncate">{m.zoneName}</span>
            <span className="text-right text-orange-500 font-medium">{m.oldCount}</span>
            <span className="text-right">{m.newCount}</span>
          </div>
        ))}
      </div>

      {/* Steps guide */}
      <div className="space-y-2 text-xs text-muted-foreground">
        <p className="font-medium text-foreground/80">{t('studioImport.ledMismatch.stepsTitle')}</p>
        <ol className="list-decimal pl-4 space-y-1">
          <li>{t('studioImport.ledMismatch.step1')}</li>
          <li>{t('studioImport.ledMismatch.step2')}</li>
          <li>{t('studioImport.ledMismatch.step3')}</li>
          <li>{t('studioImport.ledMismatch.step4')}</li>
        </ol>
      </div>

      <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} className="self-start">
        <RefreshCw className={cn('size-3.5 mr-1.5', refreshing && 'animate-spin')} />
        {t('studioImport.ledMismatch.refresh')}
      </Button>
    </div>
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
    const mismatches: Array<{ zoneName: string; deviceName: string; oldCount: number; newCount: number; memberKey: string }> = []

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

        if (zone.old_leds_count > 0 && currentLeds > 0 && zone.old_leds_count !== currentLeds) {
          mismatches.push({
            zoneName: zone.zone_name,
            deviceName: device.name ?? device.id,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('studioImport.title')}</DialogTitle>
        </DialogHeader>

        <ScrollArea.Root className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea.Viewport className="h-full max-h-[50vh] overflow-y-auto pr-2">
            {isLoading && (
              <div className="flex items-center justify-center gap-2 py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('studioImport.scanning')}</span>
              </div>
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
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('studioImport.layoutName')}</label>
                  <input
                    type="text"
                    className="w-full h-8 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
                    value={layoutName}
                    onChange={e => setLayoutName(e.target.value)}
                    maxLength={64}
                  />
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{t('studioImport.placements').replace('{n}', String(resolvedCount))}</span>
                  {skippedCount > 0 && (
                    <span className="text-orange-500">
                      {t('studioImport.skipUnmatched')} ({skippedCount})
                    </span>
                  )}
                </div>

                {importResult && !importResult.success && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600">
                    {t('studioImport.error')}: {importResult.error ?? importResult.detail ?? 'unknown'}
                  </div>
                )}
              </div>
            )}
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none p-px select-none">
            <ScrollArea.Thumb className="relative flex-1 rounded-full bg-foreground/10" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>

        <DialogFooter>
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
              <ArrowLeft className="size-3.5 mr-1" />
              {t('studioImport.back')}
            </Button>
          )}
          <div className="flex-1" />
          {step === 'match' && (
            <Button size="sm" onClick={handleNextFromMatch} disabled={resolvedCount === 0}>
              {t('studioImport.next')}
              <ArrowRight className="size-3.5 ml-1" />
            </Button>
          )}
          {step === 'leds' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep('confirm')}
            >
              {t('studioImport.ledMismatch.forceImport')}
            </Button>
          )}
          {step === 'confirm' && (
            <Button size="sm" onClick={handleImport} disabled={importing || resolvedCount === 0}>
              {importing ? (
                <Loader2 className="size-3.5 mr-1 animate-spin" />
              ) : (
                <Download className="size-3.5 mr-1" />
              )}
              {t('studioImport.import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
