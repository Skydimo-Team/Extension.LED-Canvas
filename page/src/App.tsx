import './App.css'
import { type ReactNode, useEffect, useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react'
import { ArrowLeftRight, ArrowUpDown, Magnet, FilePlus2, Plus, X, Pencil, Check, ChevronDown, Search, CircleHelp, ScanSearch, FolderInput } from 'lucide-react'
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  InputGroup,
  Popover,
  Portal,
  Text,
  Tooltip,
  VStack,
} from '@chakra-ui/react'
import { DeviceTree } from '@/components/DeviceTree'
import { StudioImportDialog } from '@/components/StudioImport'
import { LayoutManager } from '@/components/LayoutManager'
import { VisualGrid } from '@/components/VisualGrid'
import {
  useCanvasStore,
  getTemporalStore,
  beginCanvasHistoryBatch,
  endCanvasHistoryBatch,
  buildEditedPlacedDevice,
  computeAutoFitCanvasBounds,
  type CanvasBounds,
  type PlacedDevice,
} from '@/lib/canvasStore'
import { useBridgeStore } from '@/lib/bridge'
import type { LayoutInfo } from '@/lib/bridge'
import { t, useLocale } from '@/lib/i18n'

const LAYOUT_NAME_MAX_CHARS = 64

function contentWidth(value: string, placeholder: string) {
  return `${Math.max(value.length, placeholder.length, 2)}ch`
}

function parseGridSize(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(1, Math.round(n))
}

function sameCanvasBounds(a: CanvasBounds, b: CanvasBounds) {
  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName
  return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

function serializePlacementSyncState(placed: PlacedDevice[], canvasBounds: CanvasBounds) {
  const canvasX = Number.isFinite(canvasBounds.x) ? canvasBounds.x : 0
  const canvasY = Number.isFinite(canvasBounds.y) ? canvasBounds.y : 0

  return JSON.stringify({
    canvas: {
      width: canvasBounds.width,
      height: canvasBounds.height,
    },
    placements: placed.map(d => ({
      id: d.id,
      deviceId: d.deviceId,
      port: d.port,
      outputId: d.outputId,
      segmentId: d.segmentId,
      x: d.x - canvasX,
      y: d.y - canvasY,
      width: d.width,
      height: d.height,
      rotation: d.rotation ?? 0,
      ledsCount: d.ledsCount,
      matrix: d.matrix,
      brightness: d.brightness ?? 100,
      snapshot: d.snapshot,
    })),
  })
}

function GridSizeInput({ label, ariaLabel, value, compact, icon, onCommit, onEditStart, onEditEnd }: {
  label: string
  ariaLabel: string
  value: number
  compact: boolean
  icon: ReactNode
  onCommit: (v: number) => void
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)

  const control = (
    <HStack
      as="label"
      h="40px"
      flexShrink={0}
      gap={compact ? '1.5' : '2'}
      px={compact ? '2' : '2.5'}
      rounded="var(--radius-l)"
      borderWidth="1px"
      borderColor="border"
      bg="bg.muted"
      title={compact ? label : undefined}
    >
      {compact ? (
        <Box as="span" display="inline-flex" alignItems="center" justifyContent="center" color="fg.muted" lineHeight="0" aria-hidden="true">
          {icon}
        </Box>
      ) : (
        <Text as="span" textStyle="sm" color="fg.muted">{label}:</Text>
      )}
      <Input
        variant="flushed"
        size="sm"
        minW="2ch"
        px="0"
        h="full"
        borderBottomWidth="0"
        _focusVisible={{ boxShadow: 'none', borderBottomWidth: '0' }}
        value={text}
        onFocus={() => {
          onEditStart()
          setDraft(String(value))
        }}
        onChange={e => {
          const next = e.target.value
          setDraft(next)
          const parsed = parseGridSize(next)
          if (parsed != null) onCommit(parsed)
        }}
        onBlur={e => {
          const parsed = parseGridSize(e.currentTarget.value)
          const next = parsed ?? value
          onCommit(next)
          setDraft(null)
          onEditEnd()
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        placeholder={t('gridSize.placeholder')}
        aria-label={ariaLabel}
        style={{ width: contentWidth(text, t('gridSize.placeholder')) }}
      />
    </HStack>
  )

  if (!compact) return control

  return (
    <Tooltip.Root openDelay={120} closeDelay={80} positioning={{ placement: 'bottom' }}>
      <Tooltip.Trigger asChild>{control}</Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content textStyle="xs">{label}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  )
}

function ToolbarActionButton({ compact, label, tooltip, icon, variant = 'surface', disabled, onClick }: {
  compact: boolean
  label: string
  tooltip?: string
  icon: ReactNode
  variant?: 'surface' | 'solid'
  disabled?: boolean
  onClick: () => void
}) {
  const accessibleLabel = tooltip ?? label

  if (!compact) {
    return (
      <Button
        h="40px"
        px="3.5"
        rounded="var(--radius-l)"
        variant={variant}
        borderWidth="1px"
        onClick={onClick}
        disabled={disabled}
        title={accessibleLabel}
      >
        {icon}
        {label}
      </Button>
    )
  }

  return (
    <Tooltip.Root openDelay={120} closeDelay={80} positioning={{ placement: 'bottom' }}>
      <Tooltip.Trigger asChild>
        <IconButton
          aria-label={accessibleLabel}
          w="40px"
          h="40px"
          rounded="var(--radius-l)"
          variant={variant}
          borderWidth="1px"
          onClick={onClick}
          disabled={disabled}
          title={accessibleLabel}
        >
          {icon}
        </IconButton>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content textStyle="xs">{accessibleLabel}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  )
}

/* ── Inline editable text (for layout name) ── */
function InlineEdit({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setText(value) }, [value])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== value) onCommit(trimmed)
    else setText(value)
  }

  if (!editing) {
    return (
      <IconButton
        aria-label={t('layout.rename')}
        size="xs"
        variant="ghost"
        onClick={() => setEditing(true)}
        title={t('layout.rename')}
      >
        <Pencil size={12} />
      </IconButton>
    )
  }

  return (
    <HStack as="span" gap="1">
      <Input
        ref={inputRef}
        size="xs"
        w="100px"
        h="24px"
        rounded="var(--radius-s)"
        bg="bg.muted"
        value={text}
        maxLength={LAYOUT_NAME_MAX_CHARS}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setText(value) } }}
      />
      <IconButton aria-label={t('layout.rename')} size="2xs" variant="ghost" onClick={commit}>
        <Check size={12} />
      </IconButton>
    </HStack>
  )
}

/* ── Layout dropdown selector ── */
function LayoutSelector({ layouts, activeLayout, onSwitch, onCreate, onDelete }: {
  layouts: LayoutInfo[]
  activeLayout: LayoutInfo | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return layouts
    return layouts.filter(l => l.name.toLowerCase().includes(q))
  }, [layouts, search])

  return (
    <Popover.Root
      open={open}
      onOpenChange={e => {
        setOpen(e.open)
        if (!e.open) setSearch('')
      }}
      positioning={{ placement: 'bottom-start', offset: { mainAxis: 6, crossAxis: 0 } }}
    >
      <Popover.Trigger asChild>
        <Button
          h="40px"
          px="3"
          rounded="var(--radius-l)"
          variant="surface"
          borderWidth="1px"
          w="fit-content"
          maxW="100%"
          justifyContent="flex-start"
        >
          <ChevronDown
            size={16}
            style={{
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 150ms ease',
            }}
          />
          <Box
            w="6px"
            h="6px"
            rounded="full"
            bg={activeLayout?.registered ? 'var(--success-color)' : 'fg.muted'}
            opacity={activeLayout?.registered ? 1 : 0.35}
            flexShrink={0}
          />
          <Text as="span" truncate maxW="160px" textStyle="sm">
            {activeLayout?.name ?? t('layout.select')}
          </Text>
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="280px"
            p="0"
            overflow="hidden"
            rounded="var(--radius-l)"
            bg="bg.panel"
            borderColor="border"
            boxShadow="var(--shadow-dialog)"
          >
            <HStack gap="1.5" p="2" borderBottomWidth="1px" borderColor="border">
              <Button
                size="sm"
                variant="outline"
                borderStyle="dashed"
                flexShrink={0}
                onClick={() => onCreate(t('layout.defaultName').replace('{n}', String(layouts.length + 1)))}
              >
                <Plus size={14} />
                {t('layout.create')}
              </Button>
              <InputGroup flex="1" startElement={<Search size={14} />}>
                <Input
                  ref={searchRef}
                  size="sm"
                  variant="subtle"
                  placeholder={t('layout.search')}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </InputGroup>
            </HStack>

            <VStack align="stretch" gap="0" maxH="240px" overflowY="auto" py="1">
              {filtered.length === 0 && (
                <Text px="3" py="2" textAlign="center" textStyle="sm" color="fg.muted">
                  {t('layout.noMatch')}
                </Text>
              )}
              {filtered.map(layout => (
                <HStack
                  as="button"
                  key={layout.id}
                  h="36px"
                  w="full"
                  gap="1.5"
                  px="3"
                  textAlign="left"
                  bg={layout.id === activeLayout?.id ? 'accent.subtle' : 'transparent'}
                  _hover={{ bg: 'accent.muted' }}
                  onClick={() => {
                    onSwitch(layout.id)
                    setOpen(false)
                    setSearch('')
                  }}
                >
                  <Box
                    w="6px"
                    h="6px"
                    rounded="full"
                    bg={layout.registered ? 'var(--success-color)' : 'fg.muted'}
                    opacity={layout.registered ? 1 : 0.35}
                    flexShrink={0}
                  />
                  <Text flex="1" minW="0" truncate textStyle="sm" color="fg">
                    {layout.name}
                  </Text>
                  {layouts.length > 1 && (
                    <IconButton
                      aria-label={t('layout.delete')}
                      title={t('layout.delete')}
                      size="2xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={e => {
                        e.stopPropagation()
                        onDelete(layout.id)
                      }}
                    >
                      <X size={14} />
                    </IconButton>
                  )}
                </HStack>
              ))}
            </VStack>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  )
}

function App() {
  const locale = useLocale() // subscribe to locale changes for re-render
  const canvasBounds = useCanvasStore(s => s.canvasBounds)
  const updateCanvasBounds = useCanvasStore(s => s.updateCanvasBounds)
  const snapToGrid = useCanvasStore(s => s.snapToGrid)
  const toggleSnap = useCanvasStore(s => s.toggleSnapToGrid)
  const placedDevices = useCanvasStore(s => s.placedDevices)
  const canvasLayoutId = useCanvasStore(s => s.layoutId)
  const hydrateFromLayout = useCanvasStore(s => s.hydrateFromLayout)
  const editingDeviceId = useCanvasStore(s => s.editingDeviceId)
  const editingMatrix = useCanvasStore(s => s.editingMatrix)
  const preEditMatrix = useCanvasStore(s => s.preEditMatrix)
  const editingOrigin = useCanvasStore(s => s.editingOrigin)

  const layouts = useBridgeStore(s => s.layouts)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)
  const switchLayout = useBridgeStore(s => s.switchLayout)
  const createLayout = useBridgeStore(s => s.createLayout)
  const deleteLayout = useBridgeStore(s => s.deleteLayout)
  const renameLayout = useBridgeStore(s => s.renameLayout)
  const registerCanvas = useBridgeStore(s => s.registerCanvas)
  const unregisterCanvas = useBridgeStore(s => s.unregisterCanvas)
  const syncPlacements = useBridgeStore(s => s.syncPlacements)
  const previewPlacements = useBridgeStore(s => s.previewPlacements)
  const clearPlacementPreview = useBridgeStore(s => s.clearPlacementPreview)
  const updateSnap = useBridgeStore(s => s.updateSnap)
  const connectBridge = useBridgeStore(s => s.connect)
  const disconnectBridge = useBridgeStore(s => s.disconnect)
  const [studioImportOpen, setStudioImportOpen] = useState(false)
  const [toolbarCompact, setToolbarCompact] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const toolbarMeasureRef = useRef<HTMLDivElement>(null)

  const activeLayout = layouts.find(l => l.id === activeLayoutId) ?? null
  const canvasRegistered = activeLayout?.registered ?? false
  const canvasWidth = Math.max(1, Math.round(canvasBounds.width))
  const canvasHeight = Math.max(1, Math.round(canvasBounds.height))
  const previewSyncRef = useRef<{ layoutId: string; signature: string } | null>(null)
  const autoFitCanvasBounds = useMemo(
    () => computeAutoFitCanvasBounds(placedDevices),
    [placedDevices],
  )
  const canAutoFitCanvas = autoFitCanvasBounds != null
    && !sameCanvasBounds(canvasBounds, autoFitCanvasBounds)
    && !editingDeviceId

  useEffect(() => {
    connectBridge()
    return () => disconnectBridge()
  }, [connectBridge, disconnectBridge])

  const measureToolbarCompact = useCallback(() => {
    const toolbarEl = toolbarRef.current
    const measureEl = toolbarMeasureRef.current
    if (!toolbarEl || !measureEl) return

    const availableWidth = Math.floor(toolbarEl.clientWidth)
    const requiredWidth = Math.ceil(measureEl.getBoundingClientRect().width)
    setToolbarCompact(requiredWidth > availableWidth)
  }, [])

  useLayoutEffect(() => {
    const toolbarEl = toolbarRef.current
    const measureEl = toolbarMeasureRef.current
    if (!toolbarEl || !measureEl) return

    const resizeObserver = new ResizeObserver(() => {
      measureToolbarCompact()
    })

    resizeObserver.observe(toolbarEl)
    resizeObserver.observe(measureEl)
    measureToolbarCompact()

    return () => resizeObserver.disconnect()
  }, [measureToolbarCompact, locale, activeLayout?.name, canvasWidth, canvasHeight, canvasRegistered])

  const editingPreviewDevices = useMemo(() => {
    if (!editingDeviceId || !editingMatrix) return null

    const referenceMatrix = preEditMatrix ?? editingMatrix
    return placedDevices.map(device => (
      device.id === editingDeviceId
        ? buildEditedPlacedDevice(device, editingMatrix, referenceMatrix, editingOrigin)
        : device
    ))
  }, [editingDeviceId, editingMatrix, editingOrigin, placedDevices, preEditMatrix])

  const committedPlacementSignature = useMemo(
    () => serializePlacementSyncState(placedDevices, canvasBounds),
    [placedDevices, canvasBounds],
  )

  const editingPreviewSignature = useMemo(
    () => editingPreviewDevices
      ? serializePlacementSyncState(editingPreviewDevices, canvasBounds)
      : null,
    [editingPreviewDevices, canvasBounds],
  )

  // Hydrate canvas store when active layout changes or layouts arrive from backend.
  // After hydration we record the serialized signature so the debounced-sync
  // effect can tell "this state came from the backend" and avoid sending it
  // right back — preventing a redundant round-trip that could persist stale
  // runtime data.
  const hydratedRef = useRef<string | null>(null)
  const lastHydratedSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeLayout) return
    if (hydratedRef.current === activeLayout.id && canvasLayoutId === activeLayout.id) return
    hydratedRef.current = activeLayout.id
    hydrateFromLayout(
      activeLayout.id,
      activeLayout.canvas,
      activeLayout.placements,
      activeLayout.snap_to_grid,
    )
    // Snapshot the signature that results from hydration so the sync effect
    // can compare against it and skip the redundant write-back.
    queueMicrotask(() => {
      const state = useCanvasStore.getState()
      lastHydratedSignatureRef.current = serializePlacementSyncState(
        state.placedDevices,
        state.canvasBounds,
      )
    })
  }, [activeLayout, canvasLayoutId, hydrateFromLayout])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      const state = useCanvasStore.getState()
      const isModifierPressed = event.ctrlKey || event.metaKey
      if (state.editingDeviceId) {
        if (!isModifierPressed || event.altKey) return

        const key = event.key.toLowerCase()
        if (!event.shiftKey && key === 'z') {
          state.undoEdit()
          event.preventDefault()
          return
        }

        if ((event.shiftKey && key === 'z') || key === 'y') {
          state.redoEdit()
          event.preventDefault()
        }
        return
      }

      if (!isModifierPressed || event.altKey) return

      const key = event.key.toLowerCase()
      if (!event.shiftKey && key === 'z') {
        getTemporalStore().getState().undo()
        event.preventDefault()
        return
      }

      if ((event.shiftKey && key === 'z') || key === 'y') {
        getTemporalStore().getState().redo()
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const activePreview = previewSyncRef.current

    if (
      editingDeviceId
      && activeLayoutId
      && canvasLayoutId === activeLayoutId
      && editingPreviewDevices
      && editingPreviewSignature
      && editingPreviewSignature !== committedPlacementSignature
    ) {
      if (
        !activePreview
        || activePreview.layoutId !== activeLayoutId
        || activePreview.signature !== editingPreviewSignature
      ) {
        previewPlacements(activeLayoutId, editingPreviewDevices, canvasBounds)
        previewSyncRef.current = {
          layoutId: activeLayoutId,
          signature: editingPreviewSignature,
        }
      }
      return
    }

    if (
      editingDeviceId
      && activeLayoutId
      && activePreview
      && activePreview.layoutId === activeLayoutId
      && editingPreviewSignature === committedPlacementSignature
    ) {
      clearPlacementPreview(activeLayoutId)
      previewSyncRef.current = null
      return
    }

    if (!editingDeviceId && activePreview) {
      if (
        activePreview.layoutId === activeLayoutId
        && canvasLayoutId === activeLayoutId
        && activePreview.signature === committedPlacementSignature
      ) {
        syncPlacements(activeLayoutId, placedDevices, canvasBounds)
      } else {
        clearPlacementPreview(activePreview.layoutId)
      }
      previewSyncRef.current = null
    }
  }, [
    activeLayoutId,
    canvasBounds,
    canvasLayoutId,
    clearPlacementPreview,
    committedPlacementSignature,
    editingDeviceId,
    editingPreviewDevices,
    editingPreviewSignature,
    placedDevices,
    previewPlacements,
    syncPlacements,
  ])

  // Debounced placement sync — only syncs when the local state diverges from
  // what was last hydrated from the backend, preventing a redundant round-trip
  // that would echo runtime display data back as persisted config.
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!activeLayoutId) return
    if (canvasLayoutId !== activeLayoutId) return
    // Skip sync when the current state is identical to what we just hydrated
    // from the backend — nothing has changed locally, so sending it back would
    // be a no-op at best and a config contamination vector at worst.
    if (
      lastHydratedSignatureRef.current != null
      && committedPlacementSignature === lastHydratedSignatureRef.current
    ) {
      return
    }
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      syncPlacements(activeLayoutId, placedDevices, canvasBounds)
    }, 200)
    return () => clearTimeout(syncTimerRef.current)
  }, [placedDevices, canvasBounds, activeLayoutId, canvasLayoutId, syncPlacements, committedPlacementSignature])

  // Sync snap_to_grid changes to backend
  const prevSnapRef = useRef(snapToGrid)
  useEffect(() => {
    if (!activeLayoutId) return
    if (prevSnapRef.current === snapToGrid) return
    prevSnapRef.current = snapToGrid
    updateSnap(activeLayoutId, snapToGrid)
  }, [snapToGrid, activeLayoutId, updateSnap])

  const handleToggleRegister = useCallback(() => {
    if (!activeLayoutId) return
    if (canvasRegistered) {
      unregisterCanvas(activeLayoutId)
    } else {
      registerCanvas(activeLayoutId, canvasWidth, canvasHeight)
    }
  }, [activeLayoutId, canvasRegistered, canvasWidth, canvasHeight, registerCanvas, unregisterCanvas])

  const handleAutoFitCanvas = useCallback(() => {
    if (!autoFitCanvasBounds || editingDeviceId) return
    if (sameCanvasBounds(canvasBounds, autoFitCanvasBounds)) return

    beginCanvasHistoryBatch()
    updateCanvasBounds(autoFitCanvasBounds)
    endCanvasHistoryBatch()
  }, [autoFitCanvasBounds, canvasBounds, editingDeviceId, updateCanvasBounds])

  const renderToolbarContents = (compact: boolean) => (
    <>
      <LayoutSelector
        layouts={layouts}
        activeLayout={activeLayout}
        onSwitch={switchLayout}
        onCreate={createLayout}
        onDelete={deleteLayout}
      />

      {activeLayout && (
        <InlineEdit
          value={activeLayout.name}
          onCommit={name => renameLayout(activeLayout.id, name)}
        />
      )}

      <ToolbarActionButton
        compact={compact}
        label={t('studioImport.button')}
        tooltip={t('studioImport.title')}
        icon={<FolderInput size={16} />}
        onClick={() => setStudioImportOpen(true)}
      />

      <Box flex="1" />

      <GridSizeInput
        label={t('gridSize.width')}
        ariaLabel={t('gridSize.widthLabel')}
        value={canvasWidth}
        compact={compact}
        icon={<ArrowLeftRight size={16} />}
        onCommit={v => updateCanvasBounds({ width: v })}
        onEditStart={beginCanvasHistoryBatch}
        onEditEnd={endCanvasHistoryBatch}
      />
      <GridSizeInput
        label={t('gridSize.height')}
        ariaLabel={t('gridSize.heightLabel')}
        value={canvasHeight}
        compact={compact}
        icon={<ArrowUpDown size={16} />}
        onCommit={v => updateCanvasBounds({ height: v })}
        onEditStart={beginCanvasHistoryBatch}
        onEditEnd={endCanvasHistoryBatch}
      />
      <ToolbarActionButton
        compact={compact}
        label={t('canvas.autoFit')}
        icon={<ScanSearch size={16} />}
        onClick={handleAutoFitCanvas}
        disabled={!canAutoFitCanvas}
      />
      <IconButton
        aria-label={snapToGrid ? t('snap.on') : t('snap.off')}
        w="40px"
        h="40px"
        rounded="var(--radius-l)"
        variant={snapToGrid ? 'solid' : 'surface'}
        borderWidth="1px"
        onClick={toggleSnap}
        title={snapToGrid ? t('snap.on') : t('snap.off')}
      >
        <Magnet size={16} />
      </IconButton>
      <ToolbarActionButton
        compact={compact}
        label={canvasRegistered ? t('canvas.deactivate') : t('canvas.register')}
        tooltip={canvasRegistered ? t('canvas.registered') : t('canvas.unregistered')}
        icon={<FilePlus2 size={16} />}
        variant={canvasRegistered ? 'solid' : 'surface'}
        onClick={handleToggleRegister}
      />
    </>
  )

  return (
    <Flex position="relative" h="100vh" w="100vw" p="2.5" direction="column" gap="2.5" overflow="hidden">
      <HStack ref={toolbarRef} h="48px" flexShrink={0} gap="2.5" align="center" minW="0" overflow="hidden">
        {renderToolbarContents(toolbarCompact)}
      </HStack>
      <HStack
        ref={toolbarMeasureRef}
        h="48px"
        gap="2.5"
        align="center"
        position="absolute"
        top="-9999px"
        left="0"
        w="max-content"
        visibility="hidden"
        pointerEvents="none"
        aria-hidden="true"
      >
        {renderToolbarContents(false)}
      </HStack>

      <Flex flex="1" gap="2.5" minH="0">
        <Box
          flex="1"
          minW="0"
          rounded="var(--radius-l)"
          bg="bg.muted"
          borderWidth="1px"
          borderColor="border"
          overflow="hidden"
        >
          <VisualGrid />
        </Box>

        <VStack flexShrink={0} minH="0" gap="2.5" align="stretch" w="clamp(260px, 26%, 380px)">
          <Box
            flexBasis="50%"
            minH="0"
            rounded="var(--radius-l)"
            bg="bg.muted"
            borderWidth="1px"
            borderColor="border.muted"
            overflow="hidden"
          >
            <DeviceTree />
          </Box>
          <Box
            flexBasis="50%"
            minH="0"
            rounded="var(--radius-l)"
            bg="bg.muted"
            borderWidth="1px"
            borderColor="border.muted"
            overflow="hidden"
          >
            <LayoutManager />
          </Box>
        </VStack>
      </Flex>

      <Box position="absolute" left="4" bottom="4" zIndex="30">
        <Tooltip.Root openDelay={120} closeDelay={80} positioning={{ placement: 'top-start' }}>
          <Tooltip.Trigger asChild>
            <IconButton
              aria-label={t('canvas.help.ariaLabel')}
              h="36px"
              w="36px"
              rounded="full"
              variant="surface"
              borderWidth="1px"
            >
              <CircleHelp size={16} />
            </IconButton>
          </Tooltip.Trigger>
          <Portal>
            <Tooltip.Positioner>
              <Tooltip.Content maxW="280px" textStyle="xs" lineHeight="1.5">
                {t('canvas.help.description')}
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Portal>
        </Tooltip.Root>
      </Box>

      <StudioImportDialog open={studioImportOpen} onOpenChange={setStudioImportOpen} />
    </Flex>
  )
}

export default App
