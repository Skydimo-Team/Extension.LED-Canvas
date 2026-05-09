import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  ArrowLeftRight,
  ChevronRight,
  RefreshCw,
  Plus,
  Minus,
  Sun,
  TriangleAlert,
  UserRoundPen,
  Search,
} from 'lucide-react'
import {
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  InputGroup,
  Portal,
  ScrollArea,
  Slider,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useBridgeStore } from '@/lib/bridge'
import { useCanvasStore, beginCanvasHistoryBatch, endCanvasHistoryBatch, computeMismatchFlags } from '@/lib/canvasStore'
import type { PlacedDevice } from '@/lib/canvasStore'
import type { PlacementSnapshot, Segment, TreeDevice } from '@/types'
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
    <HStack gap="2" pt="0.5" pb="1">
      <Box as={Sun} boxSize="3" color="fg.muted" opacity={0.45} flexShrink={0} />
      <Slider.Root
        value={[brightness]}
        min={0}
        max={100}
        step={1}
        flex="1"
        size="sm"
        aria-label={[t('layoutManager.brightness')]}
        onValueChange={e => handleChange(e.value)}
        onPointerDown={handlePointerDown}
        onValueChangeEnd={e => handleCommit(e.value)}
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumbs />
        </Slider.Control>
      </Slider.Root>
      <Text textStyle="2xs" color="fg.muted" fontVariantNumeric="tabular-nums" w="7" textAlign="right" flexShrink={0} userSelect="none">
        {brightness}%
      </Text>
    </HStack>
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
    <HStack justify="flex-end" pt="1" pb="1.5">
      <Button
        size="2xs"
        variant="surface"
        borderWidth="1px"
        onClick={handleClick}
        title={t('device.mirrorHorizontal')}
      >
        <ArrowLeftRight size={12} />
        {t('device.mirror')}
      </Button>
    </HStack>
  )
}

/* ── Leaf item: name + brightness as one visual unit ── */
function LeafItem({
  name,
  indentPx,
  placedDevice,
  selectedId,
  stale,
  ledCountMismatch,
  layoutMismatch,
  onSelect,
  onToggle,
}: {
  name: string
  indentPx: number
  placedDevice: PlacedDevice | undefined
  selectedId: string | null
  stale: boolean
  ledCountMismatch: boolean
  layoutMismatch: boolean
  onSelect: () => void
  onToggle: (e: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const placed = !!placedDevice
  const selected = placed && placedDevice.id === selectedId
  const renderPlacement = placedDevice

  return (
    <Box
      position="relative"
      mx="1"
      rounded="var(--radius-s)"
      transition="background 180ms ease"
      bg={placed ? (selected ? 'accent.subtle' : 'bg.subtle') : 'transparent'}
      _hover={{
        bg: placed ? 'accent.subtle' : 'bg.subtle',
        '& .device-tree-add-button': { opacity: 0.72, pointerEvents: 'auto' },
      }}
    >
      <Box
        position="absolute"
        left="0"
        top="1.5"
        bottom="1.5"
        w="2px"
        rounded="full"
        bg="accent.solid"
        opacity={placed ? (selected ? 1 : 0.35) : 0}
        transform={placed ? 'scaleY(1)' : 'scaleY(0)'}
        transition="opacity 180ms ease, transform 180ms ease"
      />

      <HStack
        h="28px"
        pr="2"
        gap="1"
        textStyle="xs"
        color={selected ? 'accent.solid' : placed ? 'fg' : 'fg.muted'}
        cursor={placed ? 'pointer' : 'default'}
        transition="color 180ms ease"
        style={{ paddingLeft: indentPx }}
        title={name}
        onClick={onSelect}
      >
        <Text truncate flex="1">{name}</Text>
        {ledCountMismatch && (
          <Box as={TriangleAlert} boxSize="3" color="orange.500" flexShrink={0} mr="1" title={t('device.ledCountMismatch')} />
        )}
        {!ledCountMismatch && layoutMismatch && (
          <Box as={UserRoundPen} boxSize="3" color="blue.400" flexShrink={0} mr="1" title={t('device.layoutMismatch')} />
        )}
        {!ledCountMismatch && !layoutMismatch && stale && (
          <Box as={TriangleAlert} boxSize="3" color="orange.500" flexShrink={0} mr="1" title={STALE_TOOLTIP()} />
        )}
        <IconButton
          aria-label={placed ? t('device.removeFromCanvas') : t('device.addToCanvas')}
          className={placed ? undefined : 'device-tree-add-button'}
          size="2xs"
          boxSize="5"
          minW="5"
          p="0"
          rounded="var(--radius-s)"
          variant="plain"
          colorPalette={placed ? 'red' : 'gray'}
          color={placed ? 'red.500' : 'fg.muted'}
          opacity={placed ? 0.82 : 0}
          flexShrink={0}
          pointerEvents={placed ? 'auto' : 'none'}
          transition="background 160ms ease, opacity 160ms ease, color 160ms ease"
          _hover={{ bg: 'bg.subtle', opacity: 1 }}
          _active={{ bg: 'bg.muted' }}
          _focusVisible={{ opacity: 1, pointerEvents: 'auto' }}
          onClick={onToggle}
          title={placed ? t('device.removeFromCanvas') : t('device.addToCanvas')}
        >
          {placed ? <Minus size={10} /> : <Plus size={10} />}
        </IconButton>
      </HStack>

      <Box
        display="grid"
        transition="grid-template-rows 200ms ease"
        style={{ gridTemplateRows: placed ? '1fr' : '0fr' }}
      >
        <Box overflow="hidden" minH="0">
          {renderPlacement && (
            <div style={{ paddingLeft: indentPx, paddingRight: 8 }}>
              <BrightnessSlider placement={renderPlacement} />
              <Box
                display="grid"
                transition="grid-template-rows 200ms ease, opacity 200ms ease"
                style={{ gridTemplateRows: selected ? '1fr' : '0fr', opacity: selected ? 1 : 0 }}
              >
                <Box overflow="hidden" minH="0">
                  <MirrorButton placement={renderPlacement} />
                </Box>
              </Box>
            </div>
          )}
        </Box>
      </Box>
    </Box>
  )
}

/* ── Segment row (always leaf) ── */
function SegmentNode({
  segment,
  deviceId,
  outputId,
  port,
  onRequestRemove,
}: {
  segment: Segment
  deviceId: string
  outputId: string
  port: string
  onRequestRemove: (id: string, name: string) => void
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

  const liveLedsCount = segment.leds_count ?? 0
  const liveMatrix = segment.matrix ?? null
  const { ledCountMismatch, layoutMismatch } = placedDevice
    ? computeMismatchFlags(placedDevice, liveLedsCount, liveMatrix)
    : { ledCountMismatch: false, layoutMismatch: false }

  const handleSelect = () => {
    if (!placedDevice) return
    const selected = placedDevice.id === selectedId
    setSelectedId(selected ? null : placedDevice.id)
  }

  const handleToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (placedDevice) {
      if (placedDevice.snapshot?.customMatrix) {
        onRequestRemove(placedDevice.id, name)
        return
      }
      removeDevice(placedDevice.id)
      return
    }
    addDevice({
      deviceId,
      outputId,
      segmentId: segment.id,
      port,
      name,
      ledsCount: liveLedsCount,
      matrix: liveMatrix,
      snapshot: { ledsCount: liveLedsCount, matrix: liveMatrix, name } satisfies PlacementSnapshot,
    })
  }

  return (
    <LeafItem
      name={name}
      indentPx={32}
      placedDevice={placedDevice}
      selectedId={selectedId}
      stale={stale}
      ledCountMismatch={ledCountMismatch}
      layoutMismatch={layoutMismatch}
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
  onRequestRemove,
}: {
  output: TreeOutput
  deviceId: string
  port: string
  onRequestRemove: (id: string, name: string) => void
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

  const liveLedsCount = output.leds_count ?? 0
  const liveMatrix = output.matrix ?? null
  const { ledCountMismatch, layoutMismatch } = (isLeaf && placedDevice)
    ? computeMismatchFlags(placedDevice, liveLedsCount, liveMatrix)
    : { ledCountMismatch: false, layoutMismatch: false }

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
      if (placedDevice.snapshot?.customMatrix) {
        onRequestRemove(placedDevice.id, name)
        return
      }
      removeDevice(placedDevice.id)
      return
    }
    addDevice({
      deviceId,
      outputId: output.id,
      port,
      name,
      ledsCount: liveLedsCount,
      matrix: liveMatrix,
      snapshot: { ledsCount: liveLedsCount, matrix: liveMatrix, name } satisfies PlacementSnapshot,
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
        ledCountMismatch={ledCountMismatch}
        layoutMismatch={layoutMismatch}
        onSelect={handleSelect}
        onToggle={handleToggle}
      />
    )
  }

  return (
    <Box>
      <HStack
        w="calc(100% - 0.5rem)"
        h="28px"
        pr="2"
        mx="1"
        rounded="var(--radius-s)"
        cursor="pointer"
        textStyle="xs"
        color="fg"
        opacity={0.86}
        transition="background 160ms ease"
        _hover={{ bg: 'bg.subtle' }}
        style={{ paddingLeft: 16 }}
        title={name}
        onClick={() => setOpen(o => !o)}
      >
        <Box
          as={ChevronRight}
          boxSize="3"
          color="fg.muted"
          opacity={0.5}
          flexShrink={0}
          mr="1"
          transition="transform 150ms ease"
          transform={open ? 'rotate(90deg)' : 'rotate(0deg)'}
        />
        <Text truncate flex="1">{name}</Text>
      </HStack>

      <Box
        display="grid"
        transition="grid-template-rows 200ms ease"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <Box overflow="hidden" minH="0">
          {segments.map((seg, i) => (
            <SegmentNode
              key={seg.id ?? i}
              segment={seg}
              deviceId={deviceId}
              outputId={output.id}
              port={port}
              onRequestRemove={onRequestRemove}
            />
          ))}
        </Box>
      </Box>
    </Box>
  )
}

/* ── Device node ── */
function DeviceNode({ device, isLast, onRequestRemove }: { device: TreeDevice; isLast: boolean; onRequestRemove: (id: string, name: string) => void }) {
  const [open, setOpen] = useState(true)
  const name = device.name || device.nickname || device.model || device.description || device.id || '(unknown)'
  const outputs = device.outputs
  const hasChildren = outputs.length > 0

  return (
    <Box borderBottomWidth={isLast ? '0' : '1px'} borderColor="border.subtle" pb={isLast ? '0' : '0.5'} mb={isLast ? '0' : '0.5'}>
      <Button
        variant="ghost"
        justifyContent="flex-start"
        w="full"
        h="30px"
        px="2.5"
        rounded="0"
        fontSize="13px"
        fontWeight="medium"
        color="fg"
        cursor={hasChildren ? 'pointer' : 'default'}
        _hover={{ bg: hasChildren ? 'bg.subtle' : 'transparent' }}
        title={name}
        onClick={() => hasChildren && setOpen(o => !o)}
      >
        {hasChildren ? (
          <Box
            as={ChevronRight}
            boxSize="3.5"
            color="fg.muted"
            opacity={0.5}
            flexShrink={0}
            mr="1.5"
            transition="transform 150ms ease"
            transform={open ? 'rotate(90deg)' : 'rotate(0deg)'}
          />
        ) : (
          <Box w="5" flexShrink={0} />
        )}
        <Text truncate flex="1" textAlign="left">{name}</Text>
      </Button>

      {hasChildren && (
        <Box
          display="grid"
          transition="grid-template-rows 200ms ease"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
          <Box overflow="hidden" minH="0">
            {outputs.map((out, i) => (
              <OutputNode
                key={out.id ?? i}
                output={out}
                deviceId={device.id}
                port={device.port ?? device.id}
                onRequestRemove={onRequestRemove}
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

/* ── Main panel ── */
export function DeviceTree() {
  useLocale()
  const { status, devices, requestDevices } = useBridgeStore()
  const removeDevice = useCanvasStore(s => s.removeDevice)
  const [filter, setFilter] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; name: string } | null>(null)

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return devices
    return devices.filter(d => {
      const label = (d.name || d.nickname || d.model || d.description || d.id || '').toLowerCase()
      return label.includes(q)
    })
  }, [devices, filter])

  const handleRefresh = useCallback(() => { requestDevices() }, [requestDevices])

  const handleRequestRemove = useCallback((id: string, name: string) => {
    setPendingRemoval({ id, name })
  }, [])

  const handleConfirmRemove = useCallback(() => {
    if (pendingRemoval) {
      removeDevice(pendingRemoval.id)
      setPendingRemoval(null)
    }
  }, [pendingRemoval, removeDevice])

  const showSearch = devices.length > 3

  return (
    <VStack align="stretch" gap="0" h="full">
      <HStack gap="2" px="3" h="36px" borderBottomWidth="1px" borderColor="border.subtle" flexShrink={0}>
        <Text textStyle="2xs" fontWeight="semibold" textTransform="uppercase" color="fg.muted" flex="1">
          {t('device.panel')}
        </Text>
        <Box
          boxSize="1.5"
          rounded="full"
          flexShrink={0}
          bg={status === 'connected' ? 'green.500' : status === 'connecting' ? 'orange.400' : 'fg.muted'}
          opacity={status === 'disconnected' ? 0.25 : 1}
          animation={status === 'connecting' ? 'pulse 1.5s ease-in-out infinite' : undefined}
          title={status === 'connected' ? t('device.connected') : status === 'connecting' ? t('device.connecting') : t('device.disconnected')}
        />
        <IconButton
          aria-label={t('device.refresh')}
          size="2xs"
          variant="ghost"
          onClick={handleRefresh}
          title={t('device.refresh')}
        >
          <RefreshCw size={12} />
        </IconButton>
      </HStack>

      {showSearch && (
        <Box px="2" pt="1.5" flexShrink={0}>
          <InputGroup startElement={<Search size={12} />}>
            <Input
              h="26px"
              size="xs"
              variant="subtle"
              placeholder={t('device.filter')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </InputGroup>
        </Box>
      )}

      {/* List */}
      <ScrollArea.Root flex="1" overflow="hidden" size="xs">
        <ScrollArea.Viewport h="full" w="full">
          <ScrollArea.Content>
            <Box py="1">
              {filtered.length === 0 ? (
                <HStack justify="center" h="full" minH="80px">
                  <Text textStyle="xs" color="fg.muted" opacity={0.4}>
                  {devices.length === 0
                    ? status === 'connected' ? t('device.empty') : t('device.waiting')
                    : t('device.noMatch')}
                  </Text>
                </HStack>
              ) : (
                filtered.map((dev, i) => (
                  <DeviceNode key={dev.id ?? i} device={dev} isLast={i === filtered.length - 1} onRequestRemove={handleRequestRemove} />
                ))
              )}
            </Box>
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical">
          <ScrollArea.Thumb />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {/* Removal confirmation dialog for custom layouts */}
      <Dialog.Root open={!!pendingRemoval} onOpenChange={e => { if (!e.open) setPendingRemoval(null) }} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="340px" bg="bg.panel" borderColor="border" boxShadow="var(--shadow-dialog)">
              <Dialog.Header>
                <Dialog.Title fontSize="sm">{t('device.confirmRemoveTitle')}</Dialog.Title>
                <Dialog.Description fontSize="xs" color="fg.muted">
                  {t('device.confirmRemoveCustom')}
                </Dialog.Description>
              </Dialog.Header>
              <Dialog.Footer>
                <Button variant="outline" size="sm" onClick={() => setPendingRemoval(null)}>
                  {t('device.confirmRemoveNo')}
                </Button>
                <Button colorPalette="red" size="sm" onClick={handleConfirmRemove}>
                  {t('device.confirmRemoveYes')}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </VStack>
  )
}
