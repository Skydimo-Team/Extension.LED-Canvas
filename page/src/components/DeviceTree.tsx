import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  ArrowLeftRight,
  ChevronRight,
  RefreshCw,
  Plus,
  Minus,
  Sun,
  TriangleAlert,
  Search,
} from 'lucide-react'
import { ScrollArea, Slider } from 'radix-ui'
import { useBridgeStore } from '@/lib/bridge'
import { useCanvasStore, beginCanvasHistoryBatch, endCanvasHistoryBatch } from '@/lib/canvasStore'
import type { PlacedDevice } from '@/lib/canvasStore'
import type { PlacementSnapshot, Segment, TreeDevice } from '@/types'
import { cn } from '@/lib/utils'
import { t, useLocale } from '@/lib/i18n'

const STALE_TOOLTIP = () => t('device.staleTooltip')

type TreeOutput = TreeDevice['outputs'][number]

/* ── Inline brightness slider (rendered inside the placed-item container) ── */
function BrightnessSlider({ placement }: { placement: PlacedDevice }) {
  const brightness = placement.brightness
  const placementId = placement.id
  const setDeviceBrightness = useCanvasStore(s => s.setDeviceBrightness)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)
  const updatePlacementBrightness = useBridgeStore(s => s.updatePlacementBrightness)
  const batchRef = useRef(false)

  const handleChange = useCallback(
    (value: number[]) => {
      setDeviceBrightness(placementId, value[0])
    },
    [placementId, setDeviceBrightness],
  )

  const handlePointerDown = useCallback(() => {
    if (!batchRef.current) {
      batchRef.current = true
      beginCanvasHistoryBatch()
    }
  }, [])

  const handleCommit = useCallback(
    (value: number[]) => {
      if (batchRef.current) {
        batchRef.current = false
        endCanvasHistoryBatch()
      }
      if (!activeLayoutId) return
      updatePlacementBrightness(activeLayoutId, placementId, value[0])
    },
    [placementId, activeLayoutId, updatePlacementBrightness],
  )

  useEffect(() => {
    return () => {
      if (batchRef.current) {
        batchRef.current = false
        endCanvasHistoryBatch()
      }
    }
  }, [])

  return (
    <div className="flex items-center gap-2 pt-0.5 pb-1">
      <Sun className="size-3 text-muted-foreground/40 shrink-0" />
      <Slider.Root
        value={[brightness]}
        min={0}
        max={100}
        step={1}
        onValueChange={handleChange}
        onPointerDown={handlePointerDown}
        onValueCommit={handleCommit}
        className="relative flex flex-1 touch-none items-center select-none h-4"
      >
        <Slider.Track className="relative h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.06]">
          <Slider.Range className="absolute h-full bg-primary/40 rounded-full" />
        </Slider.Track>
        <Slider.Thumb className="block size-2.5 rounded-full bg-primary shadow-[0_0_3px_rgba(0,0,0,0.12)] focus-visible:outline-hidden" />
      </Slider.Root>
      <span className="text-[10px] text-muted-foreground/50 tabular-nums w-7 text-right shrink-0 select-none">
        {brightness}%
      </span>
    </div>
  )
}

function MirrorButton({ placement }: { placement: PlacedDevice }) {
  const mirrorDeviceHorizontally = useCanvasStore(s => s.mirrorDeviceHorizontally)

  const handleClick = useCallback(() => {
    beginCanvasHistoryBatch()
    mirrorDeviceHorizontally(placement.id)
    endCanvasHistoryBatch()
  }, [mirrorDeviceHorizontally, placement.id])

  return (
    <div className="flex items-center justify-end pt-1 pb-1.5">
      <button
        type="button"
        className="inline-flex h-6 items-center gap-1.5 rounded-[6px] border border-foreground/[0.06] bg-foreground/[0.03] px-2.5 text-[10px] font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/85 cursor-pointer"
        onClick={handleClick}
        title={t('device.mirrorHorizontal')}
      >
        <ArrowLeftRight className="size-3" />
        <span>{t('device.mirror')}</span>
      </button>
    </div>
  )
}

/* ── Leaf item: name + brightness as one visual unit ── */
function LeafItem({
  name,
  indentPx,
  placedDevice,
  selectedId,
  stale,
  onSelect,
  onToggle,
}: {
  name: string
  indentPx: number
  placedDevice: PlacedDevice | undefined
  selectedId: string | null
  stale: boolean
  onSelect: () => void
  onToggle: (e: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const placed = !!placedDevice
  const selected = placed && placedDevice.id === selectedId

  const cachedPlacementRef = useRef<PlacedDevice | undefined>(undefined)
  if (placedDevice) cachedPlacementRef.current = placedDevice
  const renderPlacement = placedDevice ?? cachedPlacementRef.current

  return (
    <div
      className={cn(
        'group relative mx-1 rounded-[6px] transition-colors duration-200',
        placed
          ? selected
            ? 'bg-primary/[0.08]'
            : 'bg-primary/[0.04] hover:bg-primary/[0.07]'
          : 'hover:bg-foreground/[0.04]',
      )}
    >
      {/* left accent bar — always in DOM, animated via opacity + scaleY */}
      <span className={cn(
        'absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full transition-all duration-200',
        placed
          ? selected ? 'bg-primary' : 'bg-primary/30'
          : 'bg-primary/30 opacity-0 scale-y-0',
      )} />

      {/* name row */}
      <div
        className={cn(
          'flex items-center h-[28px] pr-2 text-[12px] transition-colors duration-200',
          placed ? 'cursor-pointer' : 'cursor-default',
          selected ? 'text-primary' : placed ? 'text-foreground/80' : 'text-muted-foreground',
        )}
        style={{ paddingLeft: indentPx }}
        title={name}
        onClick={onSelect}
      >
        <span className="truncate flex-1">{name}</span>
        {stale && (
          <span className="shrink-0 mr-1" title={STALE_TOOLTIP()}>
            <TriangleAlert className="size-3 text-amber-500" />
          </span>
        )}
        <button
          type="button"
          className={cn(
            'size-5 rounded-[4px] flex items-center justify-center transition-all cursor-pointer shrink-0',
            placed
              ? 'text-destructive/60 hover:text-destructive hover:bg-destructive/10'
              : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]',
          )}
          onClick={onToggle}
          title={placed ? t('device.removeFromCanvas') : t('device.addToCanvas')}
        >
          {placed ? <Minus className="size-3" /> : <Plus className="size-3" />}
        </button>
      </div>

      {/* brightness slider — animated height via grid-template-rows */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: placed ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          {renderPlacement && (
            <div style={{ paddingLeft: indentPx, paddingRight: 8 }}>
              <BrightnessSlider placement={renderPlacement} />
              {/* mirror button — animated height via grid-template-rows */}
              <div
                className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
                style={{ gridTemplateRows: selected ? '1fr' : '0fr', opacity: selected ? 1 : 0 }}
              >
                <div className="overflow-hidden min-h-0">
                  <MirrorButton placement={renderPlacement} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Segment row (always leaf) ── */
function SegmentNode({
  segment,
  deviceId,
  outputId,
  port,
}: {
  segment: Segment
  deviceId: string
  outputId: string
  port: string
}) {
  const addDevice = useCanvasStore(s => s.addDevice)
  const removeDevice = useCanvasStore(s => s.removeDevice)
  const setSelectedId = useCanvasStore(s => s.setSelectedId)
  const selectedId = useCanvasStore(s => s.selectedId)
  const name = segment.name || segment.id || '(segment)'
  const placedDevice = useCanvasStore(s =>
    s.placedDevices.find(
      d => d.deviceId === deviceId && d.outputId === outputId && d.segmentId === segment.id,
    ),
  )
  const stale = placedDevice?.stale ?? false

  const handleSelect = () => {
    if (!placedDevice) return
    const selected = placedDevice.id === selectedId
    setSelectedId(selected ? null : placedDevice.id)
  }

  const handleToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (placedDevice) {
      removeDevice(placedDevice.id)
      return
    }
    addDevice({
      deviceId,
      outputId,
      segmentId: segment.id,
      port,
      name,
      ledsCount: segment.leds_count ?? 0,
      matrix: segment.matrix ?? null,
      snapshot: { ledsCount: segment.leds_count ?? 0, matrix: segment.matrix ?? null, name } satisfies PlacementSnapshot,
    })
  }

  return (
    <LeafItem
      name={name}
      indentPx={32}
      placedDevice={placedDevice}
      selectedId={selectedId}
      stale={stale}
      onSelect={handleSelect}
      onToggle={handleToggle}
    />
  )
}

/* ── Output row ── */
function OutputNode({
  output,
  deviceId,
  port,
}: {
  output: TreeOutput
  deviceId: string
  port: string
}) {
  const [open, setOpen] = useState(true)
  const addDevice = useCanvasStore(s => s.addDevice)
  const removeDevice = useCanvasStore(s => s.removeDevice)
  const setSelectedId = useCanvasStore(s => s.setSelectedId)
  const selectedId = useCanvasStore(s => s.selectedId)

  const name = output.name || output.id || '(output)'
  const segments = output.segments
  const hasChildren = segments.length > 0
  const isLeaf = !hasChildren
  const placedDevice = useCanvasStore(s => {
    if (!isLeaf) return undefined
    return s.placedDevices.find(
      d => d.deviceId === deviceId && d.outputId === output.id && !d.segmentId,
    )
  })
  const staleLeaf = placedDevice?.stale ?? false

  const handleSelect = () => {
    if (hasChildren) {
      setOpen(o => !o)
      return
    }
    if (!placedDevice) return
    const selected = placedDevice.id === selectedId
    setSelectedId(selected ? null : placedDevice.id)
  }

  const handleToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (placedDevice) {
      removeDevice(placedDevice.id)
      return
    }
    addDevice({
      deviceId,
      outputId: output.id,
      port,
      name,
      ledsCount: output.leds_count ?? 0,
      matrix: output.matrix ?? null,
      snapshot: { ledsCount: output.leds_count ?? 0, matrix: output.matrix ?? null, name } satisfies PlacementSnapshot,
    })
  }

  if (isLeaf) {
    return (
      <LeafItem
        name={name}
        indentPx={20}
        placedDevice={placedDevice}
        selectedId={selectedId}
        stale={staleLeaf}
        onSelect={handleSelect}
        onToggle={handleToggle}
      />
    )
  }

  return (
    <div>
      <div
        className="group flex w-full items-center h-[28px] pr-2 text-[12px] mx-1 rounded-[6px] hover:bg-foreground/[0.04] cursor-pointer text-foreground/80 transition-colors"
        style={{ paddingLeft: 16 }}
        title={name}
        onClick={() => setOpen(o => !o)}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150 mr-1',
            open && 'rotate-90',
          )}
        />
        <span className="truncate flex-1">{name}</span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          {segments.map((seg, i) => (
            <SegmentNode
              key={seg.id ?? i}
              segment={seg}
              deviceId={deviceId}
              outputId={output.id}
              port={port}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── Device node ── */
function DeviceNode({ device, isLast }: { device: TreeDevice; isLast: boolean }) {
  const [open, setOpen] = useState(true)
  const name = device.name || device.nickname || device.model || device.description || device.id || '(unknown)'
  const outputs = device.outputs
  const hasChildren = outputs.length > 0

  return (
    <div className={cn(!isLast && 'border-b border-foreground/[0.04] pb-0.5 mb-0.5')}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center h-[30px] px-2.5 text-[13px] font-medium transition-colors',
          'text-foreground',
          hasChildren ? 'cursor-pointer hover:bg-foreground/[0.04]' : 'cursor-default',
        )}
        title={name}
        onClick={() => hasChildren && setOpen(o => !o)}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 mr-1.5',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <span className="truncate flex-1 text-left">{name}</span>
      </button>

      {hasChildren && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden min-h-0">
            {outputs.map((out, i) => (
              <OutputNode
                key={out.id ?? i}
                output={out}
                deviceId={device.id}
                port={device.port ?? device.id}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Main panel ── */
export function DeviceTree() {
  useLocale() // subscribe to locale changes for re-render
  const { status, devices, connect, requestDevices } = useBridgeStore()
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return devices
    return devices.filter(d => {
      const label = (d.name || d.nickname || d.model || d.description || d.id || '').toLowerCase()
      return label.includes(q)
    })
  }, [devices, filter])

  useEffect(() => { connect() }, [connect])

  const handleRefresh = useCallback(() => { requestDevices() }, [requestDevices])

  const showSearch = devices.length > 3

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-[36px] border-b border-foreground/[0.06] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex-1">
          {t('device.panel')}
        </span>
        <span
          className={cn(
            'size-1.5 rounded-full shrink-0',
            status === 'connected'
              ? 'bg-emerald-500'
              : status === 'connecting'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-muted-foreground/25',
          )}
          title={status === 'connected' ? t('device.connected') : status === 'connecting' ? t('device.connecting') : t('device.disconnected')}
        />
        <button
          type="button"
          className="size-6 rounded-[4px] hover:bg-foreground/[0.06] flex items-center justify-center transition-colors cursor-pointer"
          onClick={handleRefresh}
          title={t('device.refresh')}
        >
          <RefreshCw className="size-3 text-muted-foreground/60" />
        </button>
      </div>

      {/* Search */}
      {showSearch && (
        <div className="px-2 pt-1.5 shrink-0">
          <div className="h-[26px] rounded-[5px] bg-foreground/[0.04] flex items-center gap-1.5 px-2">
            <Search className="size-3 text-muted-foreground/35 shrink-0" />
            <input
              className="flex-1 h-full bg-transparent border-none outline-none text-[12px] text-foreground placeholder:text-muted-foreground/40"
              placeholder={t('device.filter')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* List */}
      <ScrollArea.Root className="flex-1 overflow-hidden">
        <ScrollArea.Viewport className="h-full w-full [&>div]:!block">
          <div className="py-1">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-full min-h-[80px]">
                <span className="text-[12px] text-muted-foreground/40">
                  {devices.length === 0
                    ? status === 'connected' ? t('device.empty') : t('device.waiting')
                    : t('device.noMatch')}
                </span>
              </div>
            ) : (
              filtered.map((dev, i) => (
                <DeviceNode key={dev.id ?? i} device={dev} isLast={i === filtered.length - 1} />
              ))
            )}
          </div>
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
