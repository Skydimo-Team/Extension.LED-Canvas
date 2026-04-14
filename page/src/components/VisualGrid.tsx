import { useRef, useEffect, useState, useCallback } from 'react'
import { Stage, Layer, Shape, Group, Rect, Circle, Line, Text } from 'react-konva'
import type Konva from 'konva'
import { useCanvasStore, beginCanvasHistoryBatch, endCanvasHistoryBatch } from '@/lib/canvasStore'
import { useBridgeStore } from '@/lib/bridge'
import type { PlacedDevice } from '@/lib/canvasStore'
import type { LedColor } from '@/types'
import { t } from '@/lib/i18n'

/* ── Default canvas bounds ── */
const DEFAULT_CANVAS_W = 64
const DEFAULT_CANVAS_H = 64
const MIN_CANVAS_SIDE = 1
const EMPTY_LED_COLORS: LedColor[] = []

/* ── Grid cell constants: 1 cell = 1 LED point ── */
const CELL_SIZE = 1
/** Draw a thicker "major" line every N cells */
const MAJOR_EVERY = 8
/** Only draw per-cell (minor) lines when each cell is at least this many screen pixels */
const MIN_CELL_PX = 6

/* ── Zoom limits (screen-pixels per world-unit) ── */
const MIN_SCALE = 3   // 1 cell ≈ 3 px
const MAX_SCALE = 80  // 1 cell ≈ 80 px

/* ── Handle sizes in screen pixels ── */
const HANDLE_PX = 7
const CANVAS_HANDLE_PX = 8
const CANVAS_EDGE_HIT_PX = 10

/* ── Rotation handle offset from corner (screen pixels) ── */
const ROTATE_HANDLE_OFFSET_PX = 18
const ROTATE_HANDLE_RADIUS_PX = 4.5

/* ── Rotation snap angles and tolerance ── */
const ROTATION_SNAP_ANGLES = [0, 90, 180, 270, 360]
const ROTATION_SNAP_TOLERANCE = 8 // degrees

/* ── Read CSS custom properties for theme-aware colors ── */
function readCanvasColors() {
  const s = getComputedStyle(document.documentElement)
  return {
    canvasFill: s.getPropertyValue('--canvas-fill').trim() || 'rgba(100,149,237,0.05)',
    minor: s.getPropertyValue('--grid-line-minor').trim() || 'rgba(128,128,128,0.06)',
    major: s.getPropertyValue('--grid-line-major').trim() || 'rgba(128,128,128,0.12)',
    bounds: s.getPropertyValue('--grid-bounds').trim() || 'rgba(100,149,237,0.35)',
    origin: s.getPropertyValue('--grid-origin').trim() || 'rgba(220,80,80,0.4)',
    deviceFill: s.getPropertyValue('--device-fill').trim() || 'rgba(100,149,237,0.08)',
    deviceStroke: s.getPropertyValue('--device-stroke').trim() || 'rgba(100,149,237,0.4)',
    deviceSelectedStroke: s.getPropertyValue('--device-selected-stroke').trim() || 'rgba(100,149,237,0.8)',
    deviceStaleFill: s.getPropertyValue('--device-stale-fill').trim() || 'rgba(245,158,11,0.08)',
    deviceStaleStroke: s.getPropertyValue('--device-stale-stroke').trim() || 'rgba(245,158,11,0.5)',
    ledFill: s.getPropertyValue('--led-fill').trim() || 'rgba(90,195,120,0.5)',
    ledStroke: s.getPropertyValue('--led-stroke').trim() || 'rgba(90,195,120,0.8)',
    ledOffFill: s.getPropertyValue('--led-off-fill').trim() || 'rgba(15,23,42,0.10)',
    ledOffStroke: s.getPropertyValue('--led-off-stroke').trim() || 'rgba(15,23,42,0.22)',
    ledLockedFill: s.getPropertyValue('--led-locked-fill').trim() || 'rgba(245,158,11,0.55)',
    ledLockedStroke: s.getPropertyValue('--led-locked-stroke').trim() || 'rgba(245,158,11,0.85)',
    ledLockIcon: s.getPropertyValue('--led-lock-icon').trim() || 'rgba(255,255,255,0.95)',
    ledIndexText: s.getPropertyValue('--led-index-text').trim() || 'rgba(255,255,255,0.96)',
    ledGhostStroke: s.getPropertyValue('--led-ghost-stroke').trim() || 'rgba(150,150,150,0.45)',
    handleFill: s.getPropertyValue('--handle-fill').trim() || 'rgba(100,149,237,0.9)',
    handleStroke: s.getPropertyValue('--handle-stroke').trim() || 'rgba(255,255,255,0.9)',
    rotateHandleFill: s.getPropertyValue('--rotate-handle-fill').trim() || 'rgba(14,165,233,0.9)',
    rotateHandleStroke: s.getPropertyValue('--rotate-handle-stroke').trim() || 'rgba(255,255,255,0.9)',
    rotateGuide: s.getPropertyValue('--rotate-guide').trim() || 'rgba(14,165,233,0.35)',
    staleWarning: s.getPropertyValue('--stale-warning').trim() || 'rgba(245,158,11,0.9)',
    editGridLine: s.getPropertyValue('--edit-grid-line').trim() || 'rgba(100,149,237,0.2)',
    editGridExtent: s.getPropertyValue('--edit-grid-extent').trim() || 'rgba(100,149,237,0.06)',
    editConfirmFill: s.getPropertyValue('--edit-confirm-fill').trim() || 'rgba(34,197,94,0.9)',
    editCancelFill: s.getPropertyValue('--edit-cancel-fill').trim() || 'rgba(239,68,68,0.85)',
    editLedDrag: s.getPropertyValue('--edit-led-drag').trim() || 'rgba(100,149,237,0.6)',
  }
}

function mixChannel(value: number, target: number, amount: number) {
  return Math.round(value + (target - value) * amount)
}

function hasVisibleColor(color: LedColor | undefined) {
  return !!color && (color.r > 0 || color.g > 0 || color.b > 0)
}

function canvasPreviewFill(color: LedColor) {
  return `rgba(${mixChannel(color.r, 255, 0.56)}, ${mixChannel(color.g, 255, 0.56)}, ${mixChannel(color.b, 255, 0.56)}, 0.78)`
}

function devicePreviewFill(color: LedColor) {
  return `rgba(${mixChannel(color.r, 0, 0.12)}, ${mixChannel(color.g, 0, 0.12)}, ${mixChannel(color.b, 0, 0.12)}, 0.96)`
}

function devicePreviewStroke(color: LedColor) {
  return `rgba(${mixChannel(color.r, 0, 0.28)}, ${mixChannel(color.g, 0, 0.28)}, ${mixChannel(color.b, 0, 0.28)}, 0.98)`
}

/* ── Compute LED positions within a device block (relative to top-left) ── */
/** Gap between LED rects as a fraction of cell size */
const LED_GAP_RATIO = 0.10
const CANVAS_PREVIEW_GAP_RATIO = 0.10
/** Corner radius as a fraction of the LED rect's shorter side */
const LED_CORNER_RATIO = 0.20
const LED_INDEX_TARGET_FONT_PX = 11
const LED_INDEX_MIN_FONT_PX = 7.5
const LED_INDEX_TEXT_WIDTH_RATIO = 0.84
const LED_INDEX_TEXT_HEIGHT_RATIO = 0.66
const LED_INDEX_CHAR_WIDTH_RATIO = 0.62

/** Stroke a rounded-rect path with a dashed line (does NOT call save/restore). */
function strokeDashedRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, cr: number,
  dash: number, strokeStyle: string, lineWidth: number,
) {
  ctx.setLineDash([dash, dash])
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  if (cr > 0) {
    const r = Math.min(cr, w / 2, h / 2)
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  } else {
    ctx.rect(x, y, w, h)
  }
  ctx.stroke()
}

interface LedRenderInfo {
  index: number
  /** top-left x of the LED rect */
  x: number
  /** top-left y of the LED rect */
  y: number
  w: number
  h: number
  cr: number
  /** True if this LED no longer exists on the live device (show as dashed ghost) */
  ghost: boolean
}

/**
 * Compute ALL LED positions within a device block — both active and ghost.
 *
 * When a device is stale and its snapshot has more LEDs than the current live
 * device, we use the **snapshot's** grid dimensions for cell sizing so that
 * active LEDs stay at their original positions/sizes and ghost LEDs fill the
 * gaps consistently.  This avoids the stretching issue where active LEDs would
 * expand to fill the full block width and overlap the ghosts.
 */
function computeAllLeds(dev: PlacedDevice): LedRenderInfo[] {
  const { width, height, ledsCount, matrix, snapshot, stale } = dev
  if (ledsCount <= 0 && (!snapshot || !snapshot.ledsCount)) return []

  // When stale with fewer LEDs than the snapshot, use snapshot dimensions.
  const hasFewerLeds = stale && snapshot != null
    && typeof snapshot.ledsCount === 'number'
    && snapshot.ledsCount > ledsCount

  // Build a set of currently-active LED indices from the live device.
  const activeLedIndices = new Set<number>()
  if (matrix && matrix.width > 0 && matrix.height > 0) {
    for (const v of matrix.map) {
      if (v >= 0) activeLedIndices.add(v)
    }
  } else {
    for (let i = 0; i < ledsCount; i++) activeLedIndices.add(i)
  }

  // Choose which grid dimensions to use for cell layout.
  const gridMatrix = hasFewerLeds ? (snapshot!.matrix ?? null) : matrix
  const gridLedsCount = hasFewerLeds ? snapshot!.ledsCount : ledsCount

  const result: LedRenderInfo[] = []

  if (gridMatrix && gridMatrix.width > 0 && gridMatrix.height > 0) {
    const cellW = width / gridMatrix.width
    const cellH = height / gridMatrix.height
    const gapW = cellW * LED_GAP_RATIO
    const gapH = cellH * LED_GAP_RATIO
    const ledW = cellW - gapW
    const ledH = cellH - gapH
    const cr = Math.min(ledW, ledH) * LED_CORNER_RATIO

    for (let i = 0; i < gridMatrix.map.length; i++) {
      const idx = gridMatrix.map[i]
      if (idx >= 0) {
        const col = i % gridMatrix.width
        const row = Math.floor(i / gridMatrix.width)
        result.push({
          index: idx,
          x: col * cellW + gapW / 2,
          y: row * cellH + gapH / 2,
          w: ledW,
          h: ledH,
          cr,
          ghost: hasFewerLeds && !activeLedIndices.has(idx),
        })
      }
    }
  } else {
    const cols = gridLedsCount
    const cellW = width / cols
    const gapW = cellW * LED_GAP_RATIO
    const gapH = height * LED_GAP_RATIO
    const ledW = cellW - gapW
    const ledH = height - gapH
    const cr = Math.min(ledW, ledH) * LED_CORNER_RATIO

    for (let i = 0; i < gridLedsCount; i++) {
      result.push({
        index: i,
        x: i * cellW + gapW / 2,
        y: gapH / 2,
        w: ledW,
        h: ledH,
        cr,
        ghost: hasFewerLeds && !activeLedIndices.has(i),
      })
    }
  }

  return result
}

function getLedIndexFontSize(led: LedRenderInfo, stageScale: number) {
  const widthPx = led.w * stageScale
  const heightPx = led.h * stageScale
  if (widthPx <= 0 || heightPx <= 0) return null

  const digits = String(led.index).length
  const maxByWidth = (widthPx * LED_INDEX_TEXT_WIDTH_RATIO)
    / Math.max(1, digits * LED_INDEX_CHAR_WIDTH_RATIO)
  const maxByHeight = heightPx * LED_INDEX_TEXT_HEIGHT_RATIO
  const fontPx = Math.min(LED_INDEX_TARGET_FONT_PX, maxByWidth, maxByHeight)

  if (!Number.isFinite(fontPx) || fontPx < LED_INDEX_MIN_FONT_PX) return null
  return fontPx / stageScale
}

/* ── Resize states tracked in refs (avoids re-renders during drag) ── */
interface DeviceResizeState {
  deviceId: string
  corner: 'tl' | 'tr' | 'bl' | 'br'
  anchorX: number
  anchorY: number
  aspect: number
}

/* ── Rotation state tracked in ref ── */
interface DeviceRotateState {
  deviceId: string
  /** Center of the device in world coords (rotation pivot) */
  centerX: number
  centerY: number
  /** Angle at drag start (degrees) */
  startAngle: number
  /** Pointer angle at drag start (degrees) */
  startPointerAngle: number
}

type CanvasResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'r' | 'b' | 'l'

interface CanvasResizeState {
  handle: CanvasResizeHandle
  left: number
  top: number
  right: number
  bottom: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getEditPreviewMetrics(
  dev: PlacedDevice,
  editingMatrix: { width: number; height: number },
  referenceMatrix: { width: number; height: number },
  editingOrigin: { col: number; row: number } | null,
) {
  const baseCols = Math.max(1, referenceMatrix.width)
  const baseRows = Math.max(1, referenceMatrix.height)
  const cellW = dev.width / baseCols
  const cellH = dev.height / baseRows
  const origin = editingOrigin ?? { col: 0, row: 0 }

  return {
    x: dev.x + origin.col * cellW,
    y: dev.y + origin.row * cellH,
    width: Math.max(cellW, editingMatrix.width * cellW),
    height: Math.max(cellH, editingMatrix.height * cellH),
    cellW,
    cellH,
  }
}

export function VisualGrid() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [stageScale, setStageScale] = useState(1)
  const [draggingLedKey, setDraggingLedKey] = useState<string | null>(null)

  /* store state */
  const placedDevices = useCanvasStore(s => s.placedDevices)
  const canvasBounds = useCanvasStore(s => s.canvasBounds)
  const snapToGrid = useCanvasStore(s => s.snapToGrid)
  const selectedId = useCanvasStore(s => s.selectedId)
  const setSelectedId = useCanvasStore(s => s.setSelectedId)
  const updateDevice = useCanvasStore(s => s.updateDevice)
  const updateCanvasBounds = useCanvasStore(s => s.updateCanvasBounds)
  const previewByLayoutId = useBridgeStore(s => s.previewByLayoutId)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)

  /* edit mode state */
  const editingDeviceId = useCanvasStore(s => s.editingDeviceId)
  const editingMatrix = useCanvasStore(s => s.editingMatrix)
  const editingAvailableLedCount = useCanvasStore(s => s.editingAvailableLedCount)
  const preEditMatrix = useCanvasStore(s => s.preEditMatrix)
  const editingOrigin = useCanvasStore(s => s.editingOrigin)
  const enterEditMode = useCanvasStore(s => s.enterEditMode)
  const exitEditMode = useCanvasStore(s => s.exitEditMode)
  const moveLed = useCanvasStore(s => s.moveLed)
  const isEditMode = editingDeviceId !== null

  useEffect(() => {
    if (!isEditMode) {
      setDraggingLedKey(null)
    }
  }, [isEditMode])

  const canvasRect = {
    x: isFiniteNumber(canvasBounds.x) ? canvasBounds.x : 0,
    y: isFiniteNumber(canvasBounds.y) ? canvasBounds.y : 0,
    width: Math.max(
      MIN_CANVAS_SIDE,
      isFiniteNumber(canvasBounds.width) ? canvasBounds.width : DEFAULT_CANVAS_W,
    ),
    height: Math.max(
      MIN_CANVAS_SIDE,
      isFiniteNumber(canvasBounds.height) ? canvasBounds.height : DEFAULT_CANVAS_H,
    ),
  }

  const activeLayoutPreview = activeLayoutId ? previewByLayoutId[activeLayoutId] : undefined
  const canvasPreviewColors = activeLayoutPreview?.canvas ?? EMPTY_LED_COLORS

  /* cache colors (re-read on theme change) */
  const [colors, setColors] = useState(readCanvasColors)
  const colorsRef = useRef(colors)
  useEffect(() => { colorsRef.current = colors }, [colors])

  /* resize interaction refs */
  const deviceResizeRef = useRef<DeviceResizeState | null>(null)
  const canvasResizeRef = useRef<CanvasResizeState | null>(null)
  const deviceRotateRef = useRef<DeviceRotateState | null>(null)

  /* ── Observe container resize ── */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ── Watch for dark/light theme toggle ── */
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const newColors = readCanvasColors()
      setColors(newColors)
      colorsRef.current = newColors
      stageRef.current?.batchDraw()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  /* ── Center view when container resizes ── */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || size.width === 0 || size.height === 0) return

    const padding = 8
    const scaleX = size.width / (canvasRect.width + padding * 2)
    const scaleY = size.height / (canvasRect.height + padding * 2)
    const scale = Math.min(scaleX, scaleY)

    stage.scale({ x: scale, y: scale })
    stage.position({
      x: (size.width - canvasRect.width * scale) / 2 - canvasRect.x * scale,
      y: (size.height - canvasRect.height * scale) / 2 - canvasRect.y * scale,
    })
    setStageScale(scale) // eslint-disable-line react-hooks/set-state-in-effect -- syncing derived scale from Konva stage
    stage.batchDraw()
  // Re-center on container resize only.
  }, [size]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Zoom on wheel ── */
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return

    const oldScale = stage.scaleX()
    const pointer = stage.getPointerPosition()
    if (!pointer) return

    let direction = e.evt.deltaY > 0 ? -1 : 1
    if (e.evt.ctrlKey) direction = -direction
    const factor = e.evt.ctrlKey
      ? (direction > 0 ? 1.3 : 1 / 1.3)
      : (direction > 0 ? 1.05 : 1 / 1.05)

    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * factor))

    const mouseWorld = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    }

    stage.scale({ x: newScale, y: newScale })
    stage.position({
      x: pointer.x - mouseWorld.x * newScale,
      y: pointer.y - mouseWorld.y * newScale,
    })
    setStageScale(newScale)
    stage.batchDraw()
  }, [])

  /* ── Grid drawing via sceneFunc ── */
  const drawGrid = useCallback((ctx: Konva.Context) => {
    const stage = stageRef.current
    if (!stage) return

    const scale = stage.scaleX()
    const pos = stage.position()
    const { width, height } = stage.size()
    const c = colorsRef.current

    const wL = -pos.x / scale
    const wT = -pos.y / scale
    const wR = (width - pos.x) / scale
    const wB = (height - pos.y) / scale

    const canvas = ctx._context as CanvasRenderingContext2D
    const cellPx = scale * CELL_SIZE // screen pixels per cell

    /* minor grid lines – only when cells are large enough to see */
    if (cellPx >= MIN_CELL_PX) {
      canvas.beginPath()
      canvas.strokeStyle = c.minor
      canvas.lineWidth = 1 / scale

      const sx = Math.floor(wL / CELL_SIZE) * CELL_SIZE
      const sy = Math.floor(wT / CELL_SIZE) * CELL_SIZE
      for (let x = sx; x <= wR; x += CELL_SIZE) {
        if (x % MAJOR_EVERY === 0) continue
        canvas.moveTo(x, wT)
        canvas.lineTo(x, wB)
      }
      for (let y = sy; y <= wB; y += CELL_SIZE) {
        if (y % MAJOR_EVERY === 0) continue
        canvas.moveTo(wL, y)
        canvas.lineTo(wR, y)
      }
      canvas.stroke()
    }

    /* major grid lines – always visible */
    canvas.beginPath()
    canvas.strokeStyle = c.major
    canvas.lineWidth = 1 / scale

    const smx = Math.floor(wL / MAJOR_EVERY) * MAJOR_EVERY
    const smy = Math.floor(wT / MAJOR_EVERY) * MAJOR_EVERY
    for (let x = smx; x <= wR; x += MAJOR_EVERY) {
      canvas.moveTo(x, wT)
      canvas.lineTo(x, wB)
    }
    for (let y = smy; y <= wB; y += MAJOR_EVERY) {
      canvas.moveTo(wL, y)
      canvas.lineTo(wR, y)
    }
    canvas.stroke()

    /* origin cross-hair */
    canvas.beginPath()
    canvas.strokeStyle = c.origin
    canvas.lineWidth = 1.5 / scale
    const arm = 2.5
    canvas.moveTo(-arm, 0)
    canvas.lineTo(arm, 0)
    canvas.moveTo(0, -arm)
    canvas.lineTo(0, arm)
    canvas.stroke()
  }, [])

  const drawCanvasPreview = useCallback((ctx: Konva.Context) => {
    if (canvasPreviewColors.length === 0) return

    const canvas = ctx._context as CanvasRenderingContext2D
    const gap = CANVAS_PREVIEW_GAP_RATIO
    const cellInset = gap / 2
    const cellSize = Math.max(0.08, 1 - gap)

    for (let i = 0; i < canvasPreviewColors.length; i++) {
      const color = canvasPreviewColors[i]
      if (!hasVisibleColor(color)) continue

      const col = i % canvasRect.width
      const row = Math.floor(i / canvasRect.width)
      if (row >= canvasRect.height) break

      canvas.fillStyle = canvasPreviewFill(color)
      canvas.fillRect(
        canvasRect.x + col + cellInset,
        canvasRect.y + row + cellInset,
        cellSize,
        cellSize,
      )
    }
  }, [canvasPreviewColors, canvasRect.height, canvasRect.width, canvasRect.x, canvasRect.y])

  /* ── Device drag handlers ── */
  const handleDeviceDragStart = useCallback((deviceId: string) => () => {
    beginCanvasHistoryBatch()
    setSelectedId(deviceId)
  }, [setSelectedId])

  const handleDeviceDragEnd = useCallback((deviceId: string) => (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target
    const oX = node.offsetX()
    const oY = node.offsetY()
    let x = node.x() - oX
    let y = node.y() - oY
    if (useCanvasStore.getState().snapToGrid) {
      x = Math.round(x)
      y = Math.round(y)
      node.position({ x: x + oX, y: y + oY })
    }
    updateDevice(deviceId, { x, y })
    endCanvasHistoryBatch()
  }, [updateDevice])

  const makeDragBound = useCallback((device: PlacedDevice, snap: boolean) => {
    if (!snap) return undefined
    const offsetX = device.width / 2
    const offsetY = device.height / 2
    return (pos: { x: number; y: number }) => ({
      x: Math.round(pos.x - offsetX) + offsetX,
      y: Math.round(pos.y - offsetY) + offsetY,
    })
  }, [])

  /* ── Resize via window-level pointer events ── */
  const startDeviceResize = useCallback((device: PlacedDevice, corner: DeviceResizeState['corner']) => {
    beginCanvasHistoryBatch()
    const anchors: Record<DeviceResizeState['corner'], { x: number; y: number }> = {
      tl: { x: device.x + device.width, y: device.y + device.height },
      tr: { x: device.x, y: device.y + device.height },
      bl: { x: device.x + device.width, y: device.y },
      br: { x: device.x, y: device.y },
    }
    deviceResizeRef.current = {
      deviceId: device.id,
      corner,
      anchorX: anchors[corner].x,
      anchorY: anchors[corner].y,
      aspect: device.originalAspect,
    }
  }, [])

  const startCanvasResize = useCallback((handle: CanvasResizeHandle) => {
    beginCanvasHistoryBatch()
    canvasResizeRef.current = {
      handle,
      left: canvasRect.x,
      top: canvasRect.y,
      right: canvasRect.x + canvasRect.width,
      bottom: canvasRect.y + canvasRect.height,
    }
    setSelectedId(null)
  }, [canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height, setSelectedId])

  /** Begin rotation drag. The pointer angle relative to device center sets the baseline. */
  const startDeviceRotate = useCallback((device: PlacedDevice, clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return
    beginCanvasHistoryBatch()
    const container = stage.container()
    const rect = container.getBoundingClientRect()
    const scale = stage.scaleX()
    const pos = stage.position()

    // Device center in world coords (account for current rotation offset)
    const cx = device.x + device.width / 2
    const cy = device.y + device.height / 2

    // Pointer in world coords
    const px = (clientX - rect.left - pos.x) / scale
    const py = (clientY - rect.top - pos.y) / scale

    const pointerAngle = Math.atan2(py - cy, px - cx) * (180 / Math.PI)

    deviceRotateRef.current = {
      deviceId: device.id,
      centerX: cx,
      centerY: cy,
      startAngle: device.rotation,
      startPointerAngle: pointerAngle,
    }
  }, [])

  useEffect(() => {
    function pointerToWorld(clientX: number, clientY: number) {
      const stage = stageRef.current
      if (!stage) return null

      const container = stage.container()
      const rect = container.getBoundingClientRect()
      const scale = stage.scaleX()
      const pos = stage.position()

      return {
        x: (clientX - rect.left - pos.x) / scale,
        y: (clientY - rect.top - pos.y) / scale,
      }
    }

    function handlePointerMove(clientX: number, clientY: number) {
      const world = pointerToWorld(clientX, clientY)
      if (!world) return

      // ── Rotation drag ──
      const rot = deviceRotateRef.current
      if (rot) {
        const { centerX, centerY, startAngle, startPointerAngle, deviceId } = rot
        const pointerAngle = Math.atan2(world.y - centerY, world.x - centerX) * (180 / Math.PI)
        const delta = pointerAngle - startPointerAngle
        let newAngle = startAngle + delta

        // Normalize to [0, 360)
        newAngle = ((newAngle % 360) + 360) % 360

        // Snap when enabled
        const snap = useCanvasStore.getState().snapToGrid
        if (snap) {
          for (const snapAngle of ROTATION_SNAP_ANGLES) {
            const normalized = snapAngle % 360
            if (Math.abs(newAngle - normalized) <= ROTATION_SNAP_TOLERANCE) {
              newAngle = normalized
              break
            }
            // Handle wrap-around near 0/360
            if (Math.abs(newAngle - (normalized + 360)) <= ROTATION_SNAP_TOLERANCE) {
              newAngle = normalized
              break
            }
          }
        }

        useCanvasStore.getState().updateDevice(deviceId, { rotation: newAngle })
        return
      }

      const canvasResize = canvasResizeRef.current
      if (canvasResize) {
        const { handle } = canvasResize
        const affectsLeft = handle === 'l' || handle === 'tl' || handle === 'bl'
        const affectsRight = handle === 'r' || handle === 'tr' || handle === 'br'
        const affectsTop = handle === 't' || handle === 'tl' || handle === 'tr'
        const affectsBottom = handle === 'b' || handle === 'bl' || handle === 'br'

        let left = canvasResize.left
        let right = canvasResize.right
        let top = canvasResize.top
        let bottom = canvasResize.bottom

        if (affectsLeft) left = world.x
        if (affectsRight) right = world.x
        if (affectsTop) top = world.y
        if (affectsBottom) bottom = world.y

        // Canvas bounds always snap to whole grid cells.
        if (affectsLeft) left = Math.round(left)
        if (affectsRight) right = Math.round(right)
        if (affectsTop) top = Math.round(top)
        if (affectsBottom) bottom = Math.round(bottom)

        if (right - left < MIN_CANVAS_SIDE) {
          if (affectsLeft && !affectsRight) {
            left = right - MIN_CANVAS_SIDE
          } else {
            right = left + MIN_CANVAS_SIDE
          }
        }

        if (bottom - top < MIN_CANVAS_SIDE) {
          if (affectsTop && !affectsBottom) {
            top = bottom - MIN_CANVAS_SIDE
          } else {
            bottom = top + MIN_CANVAS_SIDE
          }
        }

        updateCanvasBounds({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        })
        return
      }

      const rs = deviceResizeRef.current
      if (!rs) return

      const { anchorX, anchorY, aspect, corner, deviceId } = rs

      let newW = Math.abs(world.x - anchorX)
      let newH = Math.abs(world.y - anchorY)

      // Proportional scaling: use whichever dimension is larger relative to aspect.
      if (newW / aspect >= newH) {
        newH = newW / aspect
      } else {
        newW = newH * aspect
      }

      // Minimum size.
      newW = Math.max(newW, 0.5)
      newH = Math.max(newH, 0.5)

      // Snap — only round width; derive height to preserve aspect ratio.
      const snap = useCanvasStore.getState().snapToGrid
      if (snap) {
        newW = Math.max(1, Math.round(newW))
        newH = newW / aspect
      }

      // Position depends on which corner is the anchor.
      const newX = (corner === 'br' || corner === 'tr') ? anchorX : anchorX - newW
      const newY = (corner === 'br' || corner === 'bl') ? anchorY : anchorY - newH

      useCanvasStore.getState().updateDevice(deviceId, {
        x: newX,
        y: newY,
        width: newW,
        height: newH,
      })
    }

    function onMouseMove(e: MouseEvent) {
      handlePointerMove(e.clientX, e.clientY)
    }

    function onTouchMove(e: TouchEvent) {
      const first = e.touches[0]
      if (!first) return
      handlePointerMove(first.clientX, first.clientY)
      if (canvasResizeRef.current || deviceResizeRef.current || deviceRotateRef.current) {
        e.preventDefault()
      }
    }

    function clearResizeState() {
      const hadActiveInteraction = !!(
        canvasResizeRef.current
        || deviceResizeRef.current
        || deviceRotateRef.current
      )
      canvasResizeRef.current = null
      deviceResizeRef.current = null
      deviceRotateRef.current = null
      const stage = stageRef.current
      if (stage) stage.container().style.cursor = 'default'
      if (hadActiveInteraction) endCanvasHistoryBatch()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', clearResizeState)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', clearResizeState)
    window.addEventListener('touchcancel', clearResizeState)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', clearResizeState)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', clearResizeState)
      window.removeEventListener('touchcancel', clearResizeState)
    }
  }, [updateCanvasBounds])

  /* ── Click empty space to deselect ── */
  const handleStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isEditMode) return
    if (e.target === stageRef.current) {
      setSelectedId(null)
    }
  }, [isEditMode, setSelectedId])

  const handleStageTap = useCallback((e: Konva.KonvaEventObject<TouchEvent>) => {
    if (isEditMode) return
    if (e.target === stageRef.current) {
      setSelectedId(null)
    }
  }, [isEditMode, setSelectedId])

  /* ── Keyboard: Delete/Escape ── */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    el.tabIndex = 0
    el.style.outline = 'none'

    function handleKey(e: KeyboardEvent) {
      const state = useCanvasStore.getState()
      if (state.editingDeviceId) {
        if (e.key === 'Escape') {
          state.exitEditMode(false)
          e.preventDefault()
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedId) {
          state.removeDevice(state.selectedId)
          e.preventDefault()
        }
      }
      if (e.key === 'Escape') {
        state.setSelectedId(null)
      }
    }

    el.addEventListener('keydown', handleKey)
    return () => el.removeEventListener('keydown', handleKey)
  }, [])

  /* ── Derived values ── */
  const handleSize = HANDLE_PX / stageScale
  const canvasHandleSize = CANVAS_HANDLE_PX / stageScale
  const canvasEdgeHit = CANVAS_EDGE_HIT_PX / stageScale
  const rotateHandleOffset = ROTATE_HANDLE_OFFSET_PX / stageScale
  const rotateHandleRadius = ROTATE_HANDLE_RADIUS_PX / stageScale

  const c = colors

  const updateCursor = (cursor: string) => {
    const stage = stageRef.current
    if (stage) stage.container().style.cursor = cursor
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          draggable={!isEditMode}
          onWheel={handleWheel}
          onClick={handleStageClick}
          onTap={handleStageTap}
        >
          {/* Grid background layer (non-interactive) */}
          {!isEditMode && (
            <Layer listening={false}>
              <Shape sceneFunc={drawGrid} />
            </Layer>
          )}

          {/* Content layer – device blocks */}
          <Layer>
            <Rect
              x={canvasRect.x}
              y={canvasRect.y}
              width={canvasRect.width}
              height={canvasRect.height}
              fill={c.canvasFill}
              listening={false}
            />
            {!isEditMode && canvasPreviewColors.length > 0 && (
              <Shape listening={false} sceneFunc={drawCanvasPreview} />
            )}

            {placedDevices.map(dev => {
              const isBeingEdited = editingDeviceId === dev.id
              const isDimmed = isEditMode && !isBeingEdited
              const isSelected = selectedId === dev.id
              const allLeds = isBeingEdited ? [] : computeAllLeds(dev)
              const blocked = new Set(dev.blockedLedIndices)
              const isStale = dev.stale
              const rotation = dev.rotation ?? 0
              const placementColors = activeLayoutPreview?.placementsById[dev.id]

              const editMetrics = isBeingEdited && editingMatrix && preEditMatrix
                ? getEditPreviewMetrics(dev, editingMatrix, preEditMatrix, editingOrigin)
                : null
              const renderX = editMetrics?.x ?? dev.x
              const renderY = editMetrics?.y ?? dev.y
              const renderWidth = editMetrics?.width ?? dev.width
              const renderHeight = editMetrics?.height ?? dev.height
              const offsetX = renderWidth / 2
              const offsetY = renderHeight / 2

              /* ── Edit mode: use editing matrix for LED positions ── */
              const editGrid = isBeingEdited && editingMatrix && editMetrics
                ? { cols: editingMatrix.width, rows: editingMatrix.height, cellW: editMetrics.cellW, cellH: editMetrics.cellH }
                : null
              const editMap = isBeingEdited && editingMatrix ? editingMatrix.map : null
              const editCellMetrics = editGrid
                ? (() => {
                  const gapW = editGrid.cellW * LED_GAP_RATIO
                  const gapH = editGrid.cellH * LED_GAP_RATIO
                  const ledW = editGrid.cellW - gapW
                  const ledH = editGrid.cellH - gapH

                  return {
                    ...editGrid,
                    gapW,
                    gapH,
                    ledW,
                    ledH,
                    cr: Math.min(ledW, ledH) * LED_CORNER_RATIO,
                  }
                })()
                : null
              const editableLedCount = Math.max(0, isBeingEdited ? (editingAvailableLedCount ?? dev.ledsCount) : dev.ledsCount)
              const editLedCells = editCellMetrics && editMap
                ? (() => {
                  const leds: Array<{ index: number; col: number; row: number; ghost: boolean }> = []
                  for (let i = 0; i < editMap.length; i += 1) {
                    const index = editMap[i]
                    if (index >= 0) {
                      leds.push({
                        index,
                        col: i % editCellMetrics.cols,
                        row: Math.floor(i / editCellMetrics.cols),
                        ghost: index >= editableLedCount,
                      })
                    }
                  }
                  return leds
                })()
                : null
              const cancelLabel = t('editMode.cancel')
              const confirmLabel = t('editMode.confirm')

              return (
                <Group
                  key={dev.id}
                  id={`edit-group-${dev.id}`}
                  x={renderX + offsetX}
                  y={renderY + offsetY}
                  offsetX={offsetX}
                  offsetY={offsetY}
                  rotation={rotation}
                  opacity={isDimmed ? 0.15 : 1}
                  draggable={!isEditMode}
                  dragBoundFunc={makeDragBound(dev, snapToGrid)}
                  onDragStart={handleDeviceDragStart(dev.id)}
                  onDragEnd={handleDeviceDragEnd(dev.id)}
                  onClick={(e) => {
                    e.cancelBubble = true
                    if (!isEditMode) setSelectedId(dev.id)
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true
                    if (!isEditMode) setSelectedId(dev.id)
                  }}
                  onDblClick={(e) => {
                    e.cancelBubble = true
                    if (!isEditMode) enterEditMode(dev.id)
                  }}
                  onDblTap={(e) => {
                    e.cancelBubble = true
                    if (!isEditMode) enterEditMode(dev.id)
                  }}
                >
                  {/* Background rect */}
                  <Rect
                    width={renderWidth}
                    height={renderHeight}
                    fill={isStale ? c.deviceStaleFill : c.deviceFill}
                    stroke={isSelected ? c.deviceSelectedStroke : (isStale ? c.deviceStaleStroke : c.deviceStroke)}
                    strokeWidth={(isSelected ? 2 : 1) / stageScale}
                  />

                  {/* ── Edit mode: internal grid lines ── */}
                  {editGrid && (
                    <Shape
                      listening={false}
                      sceneFunc={(ctx) => {
                        const canvas = ctx._context as CanvasRenderingContext2D
                        const cols = editGrid.cols
                        const rows = editGrid.rows
                        const cellW = editGrid.cellW
                        const cellH = editGrid.cellH

                        canvas.save()

                        canvas.strokeStyle = c.editGridLine
                        canvas.lineWidth = Math.max(0.05, 0.5 / stageScale)
                        canvas.beginPath()
                        for (let col = 1; col < cols; col++) {
                          canvas.moveTo(col * cellW, 0)
                          canvas.lineTo(col * cellW, renderHeight)
                        }
                        for (let row = 1; row < rows; row++) {
                          canvas.moveTo(0, row * cellH)
                          canvas.lineTo(renderWidth, row * cellH)
                        }
                        canvas.stroke()

                        canvas.restore()
                      }}
                    />
                  )}

                  {/* ── Edit mode: draggable LED rects ── */}
                  {editCellMetrics && editLedCells?.map(led => led.ghost ? (
                    <Shape
                      key={`edit-ghost-${led.index}-${led.col}-${led.row}`}
                      listening={false}
                      sceneFunc={(ctx) => {
                        const canvas = ctx._context as CanvasRenderingContext2D
                        canvas.save()
                        strokeDashedRoundRect(
                          canvas,
                          led.col * editCellMetrics.cellW + editCellMetrics.gapW / 2,
                          led.row * editCellMetrics.cellH + editCellMetrics.gapH / 2,
                          editCellMetrics.ledW,
                          editCellMetrics.ledH,
                          editCellMetrics.cr,
                          Math.max(0.15, 2 / stageScale),
                          c.ledGhostStroke,
                          Math.max(0.08, 0.6 / stageScale),
                        )
                        canvas.restore()
                      }}
                    />
                  ) : null)}

                  {editCellMetrics && editLedCells?.map(led => {
                    if (led.ghost) return null

                    return (
                      <Rect
                        key={`edit-led-${led.index}`}
                        _useStrictMode={draggingLedKey !== `${dev.id}:${led.index}`}
                        x={led.col * editCellMetrics.cellW + editCellMetrics.gapW / 2}
                        y={led.row * editCellMetrics.cellH + editCellMetrics.gapH / 2}
                        width={editCellMetrics.ledW}
                        height={editCellMetrics.ledH}
                        cornerRadius={editCellMetrics.cr}
                        fill={c.editLedDrag}
                        stroke={c.deviceSelectedStroke}
                        strokeWidth={Math.max(0.08, 0.8 / stageScale)}
                        draggable
                        onDragStart={(e) => {
                          e.cancelBubble = true
                          setDraggingLedKey(`${dev.id}:${led.index}`)
                          updateCursor('grabbing')
                        }}
                        dragBoundFunc={(pos) => {
                          const groupNode = stageRef.current?.findOne(`#edit-group-${dev.id}`)
                          if (!groupNode) return pos

                          const transform = groupNode.getAbsoluteTransform()
                          const inv = transform.copy().invert()
                          const local = inv.point(pos)
                          const snappedCol = Math.round((local.x - editCellMetrics.gapW / 2) / editCellMetrics.cellW)
                          const snappedRow = Math.round((local.y - editCellMetrics.gapH / 2) / editCellMetrics.cellH)

                          const target = transform.point({
                            x: snappedCol * editCellMetrics.cellW + editCellMetrics.gapW / 2,
                            y: snappedRow * editCellMetrics.cellH + editCellMetrics.gapH / 2,
                          })
                          return target
                        }}
                        onDragEnd={(e) => {
                          e.cancelBubble = true
                          const node = e.target
                          const groupNode = stageRef.current?.findOne(`#edit-group-${dev.id}`)
                          if (!groupNode) {
                            setDraggingLedKey(null)
                            updateCursor('default')
                            return
                          }

                          const transform = groupNode.getAbsoluteTransform()
                          const inv = transform.copy().invert()
                          const local = inv.point({ x: node.absolutePosition().x, y: node.absolutePosition().y })
                          const newCol = Math.round((local.x - editCellMetrics.gapW / 2) / editCellMetrics.cellW)
                          const newRow = Math.round((local.y - editCellMetrics.gapH / 2) / editCellMetrics.cellH)

                          setDraggingLedKey(null)
                          moveLed(led.index, newCol, newRow)
                          updateCursor('grab')
                        }}
                        onDragMove={(e) => { e.cancelBubble = true }}
                        onMouseEnter={() => updateCursor('grab')}
                        onMouseLeave={() => updateCursor('default')}
                        onMouseDown={() => updateCursor('grabbing')}
                      />
                    )
                  })}

                  {/* ── Edit mode: LED index labels ── */}
                  {editCellMetrics && editLedCells?.map(led => {
                    if (led.ghost) return null

                      const lri: LedRenderInfo = {
                        index: led.index,
                        x: led.col * editCellMetrics.cellW + editCellMetrics.gapW / 2,
                        y: led.row * editCellMetrics.cellH + editCellMetrics.gapH / 2,
                        w: editCellMetrics.ledW,
                        h: editCellMetrics.ledH,
                        cr: editCellMetrics.cr,
                        ghost: false,
                      }
                      const fontSize = getLedIndexFontSize(lri, stageScale)
                      if (!fontSize) return null

                      return (
                        <Text
                          key={`edit-idx-${led.index}`}
                          x={lri.x}
                          y={lri.y}
                          width={lri.w}
                          height={lri.h}
                          text={String(led.index)}
                          fontSize={fontSize}
                          fontStyle="bold"
                          align="center"
                          verticalAlign="middle"
                          lineHeight={1}
                          fill={c.ledIndexText}
                          perfectDrawEnabled={false}
                          listening={false}
                        />
                      )
                  })}

                  {/* ── Edit mode: Confirm / Cancel buttons ── */}
                  {isBeingEdited && (() => {
                    const btnH = Math.max(0.8, 22 / stageScale)
                    const btnGap = Math.max(0.15, 4 / stageScale)
                    const btnY = -btnH - Math.max(0.3, 6 / stageScale)
                    const fontSize = Math.max(0.3, 11 / stageScale)
                    const cr = Math.max(0.15, 4 / stageScale)
                    const cancelBtnW = Math.max(1.8, Math.max(48, cancelLabel.length * 7 + 18) / stageScale)
                    const confirmBtnW = Math.max(1.8, Math.max(48, confirmLabel.length * 7 + 18) / stageScale)
                    const cancelBtnX = renderWidth - confirmBtnW - cancelBtnW - btnGap
                    const confirmBtnX = renderWidth - confirmBtnW

                    return (
                      <Group listening>
                        {/* Cancel button */}
                        <Group
                          onClick={(e) => { e.cancelBubble = true; exitEditMode(false) }}
                          onTap={(e) => { e.cancelBubble = true; exitEditMode(false) }}
                          onMouseEnter={() => updateCursor('pointer')}
                          onMouseLeave={() => updateCursor('default')}
                        >
                          <Rect
                            x={cancelBtnX}
                            y={btnY}
                            width={cancelBtnW}
                            height={btnH}
                            cornerRadius={cr}
                            fill={c.editCancelFill}
                          />
                          <Text
                            x={cancelBtnX}
                            y={btnY}
                            width={cancelBtnW}
                            height={btnH}
                            text={cancelLabel}
                            fontSize={fontSize}
                            fontStyle="bold"
                            fill="rgba(255,255,255,0.95)"
                            align="center"
                            verticalAlign="middle"
                            lineHeight={1}
                            listening={false}
                          />
                        </Group>
                        {/* Confirm button */}
                        <Group
                          onClick={(e) => { e.cancelBubble = true; exitEditMode(true) }}
                          onTap={(e) => { e.cancelBubble = true; exitEditMode(true) }}
                          onMouseEnter={() => updateCursor('pointer')}
                          onMouseLeave={() => updateCursor('default')}
                        >
                          <Rect
                            x={confirmBtnX}
                            y={btnY}
                            width={confirmBtnW}
                            height={btnH}
                            cornerRadius={cr}
                            fill={c.editConfirmFill}
                          />
                          <Text
                            x={confirmBtnX}
                            y={btnY}
                            width={confirmBtnW}
                            height={btnH}
                            text={confirmLabel}
                            fontSize={fontSize}
                            fontStyle="bold"
                            fill="rgba(255,255,255,0.95)"
                            align="center"
                            verticalAlign="middle"
                            lineHeight={1}
                            listening={false}
                          />
                        </Group>
                      </Group>
                    )
                  })()}

                  {/* ── Normal mode: LED rects (active + ghost in one pass) ── */}
                  {!isBeingEdited && allLeds.map((led, i) => led.ghost ? (
                    <Shape
                      key={i}
                      listening={false}
                      sceneFunc={(ctx) => {
                        const canvas = ctx._context as CanvasRenderingContext2D
                        canvas.save()
                        strokeDashedRoundRect(
                          canvas,
                          led.x, led.y, led.w, led.h, led.cr,
                          Math.max(0.15, 2 / stageScale),
                          c.ledGhostStroke,
                          Math.max(0.08, 0.5 / stageScale),
                        )
                        canvas.restore()
                      }}
                    />
                  ) : (
                    <Group key={i} listening={false}>
                      {(() => {
                        const previewColor = placementColors?.[led.index]
                        const hasPreview = previewColor != null
                        const showLiveColor = hasVisibleColor(previewColor)
                        let fill = c.ledFill
                        let stroke = c.ledStroke

                        if (blocked.has(led.index)) {
                          fill = c.ledLockedFill
                          stroke = c.ledLockedStroke
                        } else if (showLiveColor && previewColor) {
                          fill = devicePreviewFill(previewColor)
                          stroke = devicePreviewStroke(previewColor)
                        } else if (hasPreview) {
                          fill = c.ledOffFill
                          stroke = c.ledOffStroke
                        }

                        return (
                          <Rect
                            x={led.x}
                            y={led.y}
                            width={led.w}
                            height={led.h}
                            cornerRadius={led.cr}
                            fill={fill}
                            stroke={stroke}
                            strokeWidth={0.5 / stageScale}
                          />
                        )
                      })()}
                        {isSelected && (() => {
                        const ledIndexFontSize = getLedIndexFontSize(led, stageScale)
                        if (ledIndexFontSize == null) return null

                        return (
                          <Text
                            x={led.x}
                            y={led.y}
                            width={led.w}
                            height={led.h}
                            text={String(led.index)}
                            fontSize={ledIndexFontSize}
                            fontStyle="bold"
                            align="center"
                            verticalAlign="middle"
                            lineHeight={1}
                            fill={c.ledIndexText}
                            perfectDrawEnabled={false}
                            listening={false}
                          />
                        )
                      })()}
                      {blocked.has(led.index) && Math.min(led.w, led.h) >= 0.45 && (
                        <Shape
                          fill={c.ledLockIcon}
                          stroke={c.ledLockIcon}
                          strokeWidth={0.04}
                          sceneFunc={(ctx, shape) => {
                            const canvas = ctx._context as CanvasRenderingContext2D
                            const bodyW = led.w * 0.5
                            const bodyH = led.h * 0.36
                            const bodyX = led.x + (led.w - bodyW) / 2
                            const bodyY = led.y + led.h * 0.48
                            const shackleR = Math.min(led.w, led.h) * 0.18
                            const shackleCx = led.x + led.w / 2
                            const shackleCy = led.y + led.h * 0.44

                            canvas.beginPath()
                            canvas.rect(bodyX, bodyY, bodyW, bodyH)
                            canvas.moveTo(shackleCx - shackleR, bodyY)
                            canvas.lineTo(shackleCx - shackleR, shackleCy)
                            canvas.arc(shackleCx, shackleCy, shackleR, Math.PI, 0, false)
                            canvas.lineTo(shackleCx + shackleR, bodyY)
                            canvas.closePath()
                            ctx.fillStrokeShape(shape)
                          }}
                        />
                      )}
                    </Group>
                  ))}

                  {/* Stale warning badge (top-right corner) */}
                  {!isBeingEdited && isStale && (
                    <Shape
                      listening={false}
                      sceneFunc={(ctx) => {
                        const canvas = ctx._context as CanvasRenderingContext2D
                        const badgeR = Math.max(0.3, 4 / stageScale)
                        const cx = dev.width - badgeR * 0.5
                        const cy = badgeR * 0.5

                        canvas.beginPath()
                        canvas.arc(cx, cy, badgeR, 0, Math.PI * 2)
                        canvas.fillStyle = c.staleWarning
                        canvas.fill()

                        const fontSize = badgeR * 1.3
                        canvas.fillStyle = c.ledLockIcon
                        canvas.font = `bold ${fontSize}px sans-serif`
                        canvas.textAlign = 'center'
                        canvas.textBaseline = 'middle'
                        canvas.fillText('!', cx, cy + fontSize * 0.04)
                      }}
                    />
                  )}

                  {/* Resize handles — only when selected and NOT in edit mode */}
                  {isSelected && !isEditMode && ([
                    { key: 'tl' as const, cx: 0, cy: 0 },
                    { key: 'tr' as const, cx: renderWidth, cy: 0 },
                    { key: 'bl' as const, cx: 0, cy: renderHeight },
                    { key: 'br' as const, cx: renderWidth, cy: renderHeight },
                  ]).map(({ key, cx, cy }) => (
                    <Rect
                      key={`h-${key}`}
                      x={cx - handleSize / 2}
                      y={cy - handleSize / 2}
                      width={handleSize}
                      height={handleSize}
                      fill={c.handleFill}
                      stroke={c.handleStroke}
                      strokeWidth={1 / stageScale}
                      onMouseDown={(e) => {
                        e.cancelBubble = true
                        e.evt.stopPropagation()
                        startDeviceResize(dev, key)
                      }}
                      onTouchStart={(e) => {
                        e.cancelBubble = true
                        startDeviceResize(dev, key)
                      }}
                    />
                  ))}

                  {/* Rotation handles — only when selected and NOT in edit mode */}
                  {isSelected && !isEditMode && ([
                    { key: 'rot-tl', cx: -rotateHandleOffset, cy: -rotateHandleOffset },
                    { key: 'rot-tr', cx: renderWidth + rotateHandleOffset, cy: -rotateHandleOffset },
                    { key: 'rot-bl', cx: -rotateHandleOffset, cy: renderHeight + rotateHandleOffset },
                    { key: 'rot-br', cx: renderWidth + rotateHandleOffset, cy: renderHeight + rotateHandleOffset },
                  ]).map(({ key, cx, cy }) => (
                    <Group key={key}>
                      <Line
                        points={[
                          key.includes('tl') ? 0 : key.includes('tr') ? renderWidth : key.includes('bl') ? 0 : renderWidth,
                          key.includes('tl') ? 0 : key.includes('tr') ? 0 : key.includes('bl') ? renderHeight : renderHeight,
                          cx, cy,
                        ]}
                        stroke={c.rotateGuide}
                        strokeWidth={1 / stageScale}
                        dash={[3 / stageScale, 3 / stageScale]}
                        listening={false}
                      />
                      <Circle
                        x={cx}
                        y={cy}
                        radius={rotateHandleRadius}
                        fill={c.rotateHandleFill}
                        stroke={c.rotateHandleStroke}
                        strokeWidth={1 / stageScale}
                        onMouseEnter={() => updateCursor('grab')}
                        onMouseLeave={() => updateCursor('default')}
                        onMouseDown={(e) => {
                          e.cancelBubble = true
                          e.evt.stopPropagation()
                          updateCursor('grabbing')
                          startDeviceRotate(dev, e.evt.clientX, e.evt.clientY)
                        }}
                        onTouchStart={(e) => {
                          e.cancelBubble = true
                          const touch = e.evt.touches[0]
                          if (touch) startDeviceRotate(dev, touch.clientX, touch.clientY)
                        }}
                      />
                    </Group>
                  ))}

                  {/* Rotation angle indicator */}
                  {isSelected && !isEditMode && rotation !== 0 && (
                    <Text
                      x={renderWidth / 2}
                      y={-Math.max(0.6, 14 / stageScale)}
                      text={`${Math.round(rotation * 10) / 10}°`}
                      fontSize={Math.max(0.4, 11 / stageScale)}
                      fill={c.rotateHandleFill}
                      align="center"
                      offsetX={0}
                      width={renderWidth}
                      listening={false}
                    />
                  )}
                </Group>
              )
            })}
          </Layer>

          {/* Canvas bounds layer (on top, interactive resize) */}
          {!isEditMode && (
            <Layer>
              <Rect
                x={canvasRect.x}
                y={canvasRect.y}
                width={canvasRect.width}
                height={canvasRect.height}
                stroke={c.bounds}
                strokeWidth={2 / stageScale}
                listening={false}
              />

              {[
                {
                  key: 't' as const,
                  x: canvasRect.x,
                  y: canvasRect.y - canvasEdgeHit / 2,
                  width: canvasRect.width,
                  height: canvasEdgeHit,
                  cursor: 'ns-resize',
                },
                {
                  key: 'r' as const,
                  x: canvasRect.x + canvasRect.width - canvasEdgeHit / 2,
                  y: canvasRect.y,
                  width: canvasEdgeHit,
                  height: canvasRect.height,
                  cursor: 'ew-resize',
                },
                {
                  key: 'b' as const,
                  x: canvasRect.x,
                  y: canvasRect.y + canvasRect.height - canvasEdgeHit / 2,
                  width: canvasRect.width,
                  height: canvasEdgeHit,
                  cursor: 'ns-resize',
                },
                {
                  key: 'l' as const,
                  x: canvasRect.x - canvasEdgeHit / 2,
                  y: canvasRect.y,
                  width: canvasEdgeHit,
                  height: canvasRect.height,
                  cursor: 'ew-resize',
                },
              ].map(edge => (
                <Rect
                  key={`canvas-edge-${edge.key}`}
                  x={edge.x}
                  y={edge.y}
                  width={edge.width}
                  height={edge.height}
                  fill="transparent"
                  onMouseEnter={() => updateCursor(edge.cursor)}
                  onMouseLeave={() => updateCursor('default')}
                  onMouseDown={(e) => {
                    e.cancelBubble = true
                    e.evt.stopPropagation()
                    startCanvasResize(edge.key)
                  }}
                  onTouchStart={(e) => {
                    e.cancelBubble = true
                    startCanvasResize(edge.key)
                  }}
                />
              ))}

              {[
                { key: 'tl' as const, cx: canvasRect.x, cy: canvasRect.y, cursor: 'nwse-resize' },
                { key: 'tr' as const, cx: canvasRect.x + canvasRect.width, cy: canvasRect.y, cursor: 'nesw-resize' },
                { key: 'bl' as const, cx: canvasRect.x, cy: canvasRect.y + canvasRect.height, cursor: 'nesw-resize' },
                { key: 'br' as const, cx: canvasRect.x + canvasRect.width, cy: canvasRect.y + canvasRect.height, cursor: 'nwse-resize' },
              ].map(corner => (
                <Rect
                  key={`canvas-corner-${corner.key}`}
                  x={corner.cx - canvasHandleSize / 2}
                  y={corner.cy - canvasHandleSize / 2}
                  width={canvasHandleSize}
                  height={canvasHandleSize}
                  fill={c.handleFill}
                  stroke={c.handleStroke}
                  strokeWidth={1 / stageScale}
                  onMouseEnter={() => updateCursor(corner.cursor)}
                  onMouseLeave={() => updateCursor('default')}
                  onMouseDown={(e) => {
                    e.cancelBubble = true
                    e.evt.stopPropagation()
                    startCanvasResize(corner.key)
                  }}
                  onTouchStart={(e) => {
                    e.cancelBubble = true
                    startCanvasResize(corner.key)
                  }}
                />
              ))}
            </Layer>
          )}
        </Stage>
      )}
    </div>
  )
}
