/**
 * Canvas store — manages devices placed on the visual grid,
 * grid-snap toggle, and selection state for the active layout.
 *
 * When the active layout changes (via bridge full_state), call
 * `hydrateFromLayout()` to replace local state with backend data.
 */
import { create } from 'zustand'
import { temporal } from 'zundo'
import type { TemporalState } from 'zundo'
import type { StoreApi } from 'zustand'
import type { Matrix, PlacementSnapshot } from '@/types'

export interface CanvasBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedDevice {
  id: string
  deviceId: string
  outputId: string
  segmentId?: string
  /** Current runtime port resolved by the backend for this device */
  port: string
  name: string
  /** World X position */
  x: number
  /** World Y position */
  y: number
  /** World width */
  width: number
  /** World height */
  height: number
  /** Rotation angle in degrees (0–360, clockwise) */
  rotation: number
  ledsCount: number
  matrix: Matrix | null
  blockedLedIndices: number[]
  blockedLedCount: number
  availableLedCount: number
  /** Per-placement brightness (0–100, default 100) */
  brightness: number
  /** Snapshot of device state at the time of placement */
  snapshot: PlacementSnapshot | null
  /** True if the live device differs from the snapshot (needs re-add) */
  stale: boolean
  /** Stable aspect ratio (width/height) computed on creation, not affected by snap rounding */
  originalAspect: number
}

interface CanvasState {
  /** The layout id this canvas state belongs to (null = not yet hydrated) */
  layoutId: string | null
  placedDevices: PlacedDevice[]
  canvasBounds: CanvasBounds
  snapToGrid: boolean
  selectedId: string | null

  /** ID of the device currently being edited (null = not in edit mode) */
  editingDeviceId: string | null
  /** Working copy of the matrix during edit mode */
  editingMatrix: Matrix | null
  /** Number of live LEDs that remain editable during edit mode */
  editingAvailableLedCount: number | null
  /** Grid dimensions during edit mode */
  editingGridSize: { cols: number; rows: number } | null
  /** Matrix before edit started (for cancel/revert and preserving rendered cell size) */
  preEditMatrix: Matrix | null
  /** Cell offset of the editing matrix relative to the placement's original top-left */
  editingOrigin: { col: number; row: number } | null

  addDevice: (info: {
    deviceId: string
    outputId: string
    segmentId?: string
    port: string
    name: string
    ledsCount: number
    matrix: Matrix | null
    snapshot: PlacementSnapshot | null
  }) => void
  removeDevice: (id: string) => void
  updateDevice: (id: string, patch: Partial<Pick<PlacedDevice, 'x' | 'y' | 'width' | 'height' | 'rotation'>>) => void
  setDeviceBrightness: (id: string, brightness: number) => void
  mirrorDeviceHorizontally: (id: string) => void
  updateCanvasBounds: (patch: Partial<CanvasBounds>) => void
  setSnapToGrid: (snap: boolean) => void
  toggleSnapToGrid: () => void
  setSelectedId: (id: string | null) => void

  enterEditMode: (deviceId: string, liveLedsCount?: number) => void
  exitEditMode: (confirm: boolean) => void
  moveLed: (ledIndex: number, toCol: number, toRow: number) => void

  /** Replace local state with data from a backend layout snapshot */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hydrateFromLayout: (layoutId: string, canvas: CanvasBounds, placements: any[], snapToGrid: boolean) => void
}

type CanvasHistoryState = Pick<CanvasState, 'placedDevices' | 'canvasBounds' | 'snapToGrid'>

const MIN_CANVAS_SIDE = 1
const TEMPORAL_LIMIT = 50
const PLACEMENT_ID_LENGTH = 9
const PLACEMENT_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const DEFAULT_CANVAS_BOUNDS: CanvasBounds = {
  x: 0,
  y: 0,
  width: 64,
  height: 64,
}

let historyBatchDepth = 0
let historyBatchStart: CanvasHistoryState | null = null

function createPlacementId(existingIds: ReadonlySet<string>) {
  const cryptoApi = globalThis.crypto

  while (true) {
    const chars = new Array<string>(PLACEMENT_ID_LENGTH)

    if (cryptoApi?.getRandomValues) {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(PLACEMENT_ID_LENGTH))
      for (let index = 0; index < PLACEMENT_ID_LENGTH; index += 1) {
        chars[index] = PLACEMENT_ID_CHARS[bytes[index] % PLACEMENT_ID_CHARS.length]
      }
    } else {
      for (let index = 0; index < PLACEMENT_ID_LENGTH; index += 1) {
        chars[index] = PLACEMENT_ID_CHARS[Math.floor(Math.random() * PLACEMENT_ID_CHARS.length)]
      }
    }

    const id = chars.join('')
    if (!existingIds.has(id)) {
      return id
    }
  }
}

function computeDefaultSize(ledsCount: number, matrix: Matrix | null): { width: number; height: number } {
  if (matrix && matrix.width > 0 && matrix.height > 0) {
    return { width: matrix.width, height: matrix.height }
  }
  if (ledsCount <= 0) return { width: 1, height: 1 }
  return { width: ledsCount, height: 1 }
}

function buildSequentialMatrix(ledsCount: number): Matrix | null {
  const count = Math.max(0, Math.floor(ledsCount))
  if (count <= 0) return null

  return {
    width: count,
    height: 1,
    map: Array.from({ length: count }, (_, index) => index),
  }
}

function mirrorMatrixHorizontally(matrix: Matrix | null, ledsCount: number): Matrix | null {
  const source = matrix ?? buildSequentialMatrix(ledsCount)
  if (!source || source.width <= 0 || source.height <= 0) {
    return source
  }

  const cellCount = source.width * source.height
  const sourceMap = Array.isArray(source.map) ? source.map : []
  const mirroredMap = new Array<number>(cellCount)

  for (let row = 0; row < source.height; row += 1) {
    for (let col = 0; col < source.width; col += 1) {
      const sourceIndex = row * source.width + (source.width - 1 - col)
      const targetIndex = row * source.width + col
      mirroredMap[targetIndex] = typeof sourceMap[sourceIndex] === 'number'
        ? sourceMap[sourceIndex]
        : -1
    }
  }

  return {
    width: source.width,
    height: source.height,
    map: mirroredMap,
  }
}

function hasMissingSnapshotLeds(
  device: Pick<PlacedDevice, 'stale' | 'snapshot' | 'ledsCount'>,
  liveLedsCount: number,
) {
  return device.stale
    && device.snapshot != null
    && typeof device.snapshot.ledsCount === 'number'
    && device.snapshot.ledsCount > liveLedsCount
}

function buildEditModeSource(
  device: PlacedDevice,
  liveLedsCount = device.ledsCount,
): { matrix: Matrix | null; availableLedCount: number } {
  const availableLedCount = Math.max(0, Math.floor(liveLedsCount))

  if (hasMissingSnapshotLeds(device, liveLedsCount)) {
    const snapshotLedCount = device.snapshot?.ledsCount ?? 0
    return {
      matrix: device.snapshot?.matrix ?? buildSequentialMatrix(snapshotLedCount),
      availableLedCount,
    }
  }

  return {
    matrix: device.matrix ?? buildSequentialMatrix(device.ledsCount),
    availableLedCount,
  }
}

function normalizeMatrixForLedCount(matrix: Matrix, ledsCount: number): Matrix {
  const total = Math.max(0, matrix.width * matrix.height)
  const maxLedIndex = Math.max(0, Math.floor(ledsCount))
  const normalizedMap = new Array<number>(total)

  for (let index = 0; index < total; index += 1) {
    const raw = matrix.map[index]
    const ledIndex = typeof raw === 'number' ? Math.floor(raw) : Number.NaN
    normalizedMap[index] = Number.isFinite(ledIndex) && ledIndex >= 0 && ledIndex < maxLedIndex
      ? ledIndex
      : -1
  }

  return {
    width: matrix.width,
    height: matrix.height,
    map: normalizedMap,
  }
}

function makeKey(deviceId: string, outputId: string, segmentId?: string) {
  return `${deviceId}::${outputId}::${segmentId ?? ''}`
}

function serializeLayoutForComparison(matrix: Matrix | null | undefined): string {
  return JSON.stringify(matrix ?? null)
}

export function computeMismatchFlags(
  placed: PlacedDevice,
  liveLedsCount: number,
  liveMatrix: Matrix | null,
): { ledCountMismatch: boolean; layoutMismatch: boolean } {
  const snapshotCount = placed.snapshot?.ledsCount ?? placed.ledsCount
  const ledCountMismatch = liveLedsCount !== snapshotCount

  let layoutMismatch = false
  if (!ledCountMismatch) {
    const snapshotMatrix = placed.snapshot?.matrix ?? null
    layoutMismatch = serializeLayoutForComparison(snapshotMatrix) !== serializeLayoutForComparison(liveMatrix)
  }

  return { ledCountMismatch, layoutMismatch }
}

export function buildEditedPlacedDevice(
  device: PlacedDevice,
  editingMatrix: Matrix,
  referenceMatrix: Matrix,
  editingOrigin: { col: number; row: number } | null,
  options?: { persistSnapshot?: boolean },
): PlacedDevice {
  const baseCellWidth = device.width / Math.max(1, referenceMatrix.width)
  const baseCellHeight = device.height / Math.max(1, referenceMatrix.height)
  const origin = editingOrigin ?? { col: 0, row: 0 }
  const nextWidth = Math.max(baseCellWidth, editingMatrix.width * baseCellWidth)
  const nextHeight = Math.max(baseCellHeight, editingMatrix.height * baseCellHeight)
  const liveMatrix = normalizeMatrixForLedCount(editingMatrix, device.ledsCount)

  const nextSnapshot = options?.persistSnapshot
    ? {
      ...device.snapshot,
      ledsCount: device.snapshot?.ledsCount ?? device.ledsCount,
      matrix: structuredClone(editingMatrix),
      customMatrix: true,
    }
    : device.snapshot

  return {
    ...device,
    x: device.x + origin.col * baseCellWidth,
    y: device.y + origin.row * baseCellHeight,
    matrix: liveMatrix,
    width: nextWidth,
    height: nextHeight,
    originalAspect: nextWidth / (nextHeight || 1),
    snapshot: nextSnapshot,
  }
}

function trimMatrixToOccupiedBounds(
  matrix: Matrix,
  origin: { col: number; row: number },
): { matrix: Matrix; origin: { col: number; row: number } } {
  const { width, height, map } = matrix

  const isColumnEmpty = (col: number) => {
    for (let row = 0; row < height; row += 1) {
      if (map[row * width + col] >= 0) return false
    }
    return true
  }

  const isRowEmpty = (row: number) => {
    for (let col = 0; col < width; col += 1) {
      if (map[row * width + col] >= 0) return false
    }
    return true
  }

  let left = 0
  while (left < width - 1 && isColumnEmpty(left)) left += 1

  let right = width - 1
  while (right > left && isColumnEmpty(right)) right -= 1

  let top = 0
  while (top < height - 1 && isRowEmpty(top)) top += 1

  let bottom = height - 1
  while (bottom > top && isRowEmpty(bottom)) bottom -= 1

  if (left === 0 && right === width - 1 && top === 0 && bottom === height - 1) {
    return { matrix, origin }
  }

  const nextWidth = Math.max(1, right - left + 1)
  const nextHeight = Math.max(1, bottom - top + 1)
  const nextMap = new Array<number>(nextWidth * nextHeight).fill(-1)

  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      nextMap[(row - top) * nextWidth + (col - left)] = map[row * width + col]
    }
  }

  return {
    matrix: {
      width: nextWidth,
      height: nextHeight,
      map: nextMap,
    },
    origin: {
      col: origin.col + left,
      row: origin.row + top,
    },
  }
}

function trimPastStates(pastStates: Partial<CanvasHistoryState>[]) {
  return pastStates.length > TEMPORAL_LIMIT
    ? pastStates.slice(pastStates.length - TEMPORAL_LIMIT)
    : pastStates
}

/** Convert a backend placement record into a PlacedDevice with canvas offset */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function placementToDevice(p: any, canvasBounds: CanvasBounds): PlacedDevice {
  const w = p.width ?? 1
  const h = p.height ?? 1
  const deviceId = p.deviceId ?? ''
  const port = p.port ?? ''
  const fallbackIds = new Set<string>()
  return {
    id: typeof p.id === 'string' && p.id ? p.id : createPlacementId(fallbackIds),
    deviceId,
    outputId: p.outputId ?? '',
    segmentId: p.segmentId,
    port,
    name: p.name ?? `${deviceId || port || '(device)'}::${p.outputId}`,
    x: (p.x ?? 0) + canvasBounds.x,
    y: (p.y ?? 0) + canvasBounds.y,
    width: w,
    height: h,
    rotation: typeof p.rotation === 'number' ? p.rotation : 0,
    ledsCount: p.ledsCount ?? 0,
    matrix: p.matrix ?? null,
    brightness: typeof p.brightness === 'number' ? Math.max(0, Math.min(100, Math.round(p.brightness))) : 100,
    blockedLedIndices: Array.isArray(p.blockedLedIndices) ? p.blockedLedIndices : [],
    blockedLedCount: p.blockedLedCount ?? 0,
    availableLedCount: p.availableLedCount ?? (p.ledsCount ?? 0),
    snapshot: p.snapshot ?? null,
    stale: p.stale === true,
    originalAspect: w / (h || 1),
  }
}

export const useCanvasStore = create<CanvasState>()(temporal((set, get) => ({
  layoutId: null,
  placedDevices: [],
  canvasBounds: DEFAULT_CANVAS_BOUNDS,
  snapToGrid: false,
  selectedId: null,
  editingDeviceId: null,
  editingMatrix: null,
  editingAvailableLedCount: null,
  editingGridSize: null,
  preEditMatrix: null,
  editingOrigin: null,

  hydrateFromLayout(layoutId, canvas, placements, snapToGrid) {
    // Pause tracking so the hydration itself is not recorded as undoable
    resetCanvasHistoryBatch()
    const temporal = getTemporalStore()
    temporal.getState().pause()

    const bounds: CanvasBounds = {
      x: canvas?.x ?? 0,
      y: canvas?.y ?? 0,
      width: Math.max(MIN_CANVAS_SIDE, canvas?.width ?? 64),
      height: Math.max(MIN_CANVAS_SIDE, canvas?.height ?? 64),
    }
    const devices = Array.isArray(placements)
      ? placements.map((p) => placementToDevice(p, bounds))
      : []
    set({
      layoutId,
      canvasBounds: bounds,
      placedDevices: devices,
      snapToGrid: !!snapToGrid,
      selectedId: null,
      editingDeviceId: null,
      editingMatrix: null,
      editingAvailableLedCount: null,
      editingGridSize: null,
      preEditMatrix: null,
      editingOrigin: null,
    })

    // Clear history and resume tracking after hydration
    temporal.getState().clear()
    temporal.getState().resume()
  },

  addDevice(info) {
    const state = get()
    const key = makeKey(info.deviceId, info.outputId, info.segmentId)
    if (state.placedDevices.some(d => makeKey(d.deviceId, d.outputId, d.segmentId) === key)) return

    const existingIds = new Set(state.placedDevices.map(device => device.id))

    const size = computeDefaultSize(info.ledsCount, info.matrix)

    // Place next to existing devices, or at canvas origin + 1
    const cx = state.canvasBounds.x
    const cy = state.canvasBounds.y
    let x = cx + 1
    let y = cy + 1
    if (state.placedDevices.length > 0) {
      const maxRight = Math.max(...state.placedDevices.map(d => d.x + d.width))
      x = maxRight + 1
      if (x + size.width > cx + state.canvasBounds.width - 2) {
        x = cx + 1
        const maxBottom = Math.max(...state.placedDevices.map(d => d.y + d.height))
        y = maxBottom + 1
      }
    }

    set({
      placedDevices: [
        ...state.placedDevices,
        {
          id: createPlacementId(existingIds),
          deviceId: info.deviceId,
          outputId: info.outputId,
          segmentId: info.segmentId,
          port: info.port,
          name: info.name,
          x,
          y,
          width: size.width,
          height: size.height,
          rotation: 0,
          ledsCount: info.ledsCount,
          matrix: info.matrix ?? null,
          brightness: 100,
          blockedLedIndices: [],
          blockedLedCount: 0,
          availableLedCount: info.ledsCount,
          snapshot: info.snapshot,
          stale: false,
          originalAspect: size.width / size.height,
        },
      ],
    })
  },

  removeDevice(id) {
    set(s => ({
      placedDevices: s.placedDevices.filter(d => d.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      editingDeviceId: s.editingDeviceId === id ? null : s.editingDeviceId,
      editingMatrix: s.editingDeviceId === id ? null : s.editingMatrix,
      editingAvailableLedCount: s.editingDeviceId === id ? null : s.editingAvailableLedCount,
      editingGridSize: s.editingDeviceId === id ? null : s.editingGridSize,
      preEditMatrix: s.editingDeviceId === id ? null : s.preEditMatrix,
      editingOrigin: s.editingDeviceId === id ? null : s.editingOrigin,
    }))
  },

  updateDevice(id, patch) {
    set(s => ({
      placedDevices: s.placedDevices.map(d => (d.id === id ? { ...d, ...patch } : d)),
    }))
  },

  setDeviceBrightness(id, brightness) {
    const clamped = Math.max(0, Math.min(100, Math.round(brightness)))
    set(s => ({
      placedDevices: s.placedDevices.map(d => (d.id === id ? { ...d, brightness: clamped } : d)),
    }))
  },

  mirrorDeviceHorizontally(id) {
    set(s => ({
      placedDevices: s.placedDevices.map((d) => {
        if (d.id !== id) return d
        return {
          ...d,
          matrix: mirrorMatrixHorizontally(d.matrix, d.ledsCount),
        }
      }),
    }))
  },

  updateCanvasBounds(patch) {
    set(s => {
      const current = s.canvasBounds
      const nextX = Number.isFinite(patch.x) ? patch.x! : current.x
      const nextY = Number.isFinite(patch.y) ? patch.y! : current.y
      const nextW = Number.isFinite(patch.width)
        ? Math.max(MIN_CANVAS_SIDE, patch.width!)
        : current.width
      const nextH = Number.isFinite(patch.height)
        ? Math.max(MIN_CANVAS_SIDE, patch.height!)
        : current.height

      return {
        canvasBounds: {
          x: nextX,
          y: nextY,
          width: nextW,
          height: nextH,
        },
      }
    })
  },

  setSnapToGrid(snap) {
    set({ snapToGrid: snap })
  },

  toggleSnapToGrid() {
    set(s => ({ snapToGrid: !s.snapToGrid }))
  },

  setSelectedId(id) {
    set({ selectedId: id })
  },

  enterEditMode(deviceId, liveLedsCount) {
    const state = get()
    const dev = state.placedDevices.find(d => d.id === deviceId)
    if (!dev || state.editingDeviceId) return

    const { matrix: source, availableLedCount } = buildEditModeSource(dev, liveLedsCount)
    if (!source) return

    const editingMatrix = structuredClone(source)
    const preEditMatrix = structuredClone(source)

    getTemporalStore().getState().pause()

    set({
      editingDeviceId: deviceId,
      editingMatrix,
      editingAvailableLedCount: availableLedCount,
      editingGridSize: { cols: editingMatrix.width, rows: editingMatrix.height },
      preEditMatrix,
      editingOrigin: { col: 0, row: 0 },
      selectedId: deviceId,
    })
  },

  exitEditMode(confirm) {
    const state = get()
    const { editingDeviceId, editingMatrix, preEditMatrix, editingOrigin } = state
    if (!editingDeviceId) return

    if (confirm && editingMatrix) {
      const temporal = getTemporalStore()
      const { placedDevices, canvasBounds, snapToGrid } = state
      const beforeState: CanvasHistoryState = structuredClone({ placedDevices, canvasBounds, snapToGrid })
      const referenceMatrix = preEditMatrix ?? editingMatrix

      const newDevices = state.placedDevices.map(d => {
        if (d.id !== editingDeviceId) return d

        return buildEditedPlacedDevice(d, editingMatrix, referenceMatrix, editingOrigin, {
          persistSnapshot: true,
        })
      })

      set({
        placedDevices: newDevices,
        editingDeviceId: null,
        editingMatrix: null,
        editingAvailableLedCount: null,
        editingGridSize: null,
        preEditMatrix: null,
        editingOrigin: null,
      })

      temporal.getState().resume()
      temporal.setState(s => ({
        pastStates: trimPastStates([...s.pastStates, beforeState]),
        futureStates: [],
      }))
    } else {
      set({
        editingDeviceId: null,
        editingMatrix: null,
        editingAvailableLedCount: null,
        editingGridSize: null,
        preEditMatrix: null,
        editingOrigin: null,
      })
      getTemporalStore().getState().resume()
    }
  },

  moveLed(ledIndex, toCol, toRow) {
    const state = get()
    const { editingMatrix } = state
    if (!editingMatrix) return
    const editingAvailableLedCount = state.editingAvailableLedCount ?? Number.MAX_SAFE_INTEGER
    if (ledIndex >= editingAvailableLedCount) return

    const targetCol = Math.round(toCol)
    const targetRow = Math.round(toRow)
    if (!Number.isFinite(targetCol) || !Number.isFinite(targetRow)) return

    let { width, height } = editingMatrix
    let newMap = [...editingMatrix.map]
    let nextOrigin = state.editingOrigin ?? { col: 0, row: 0 }

    const oldPos = newMap.indexOf(ledIndex)
    const oldCol = oldPos >= 0 ? oldPos % width : -1
    const oldRow = oldPos >= 0 ? Math.floor(oldPos / width) : -1

    let shiftedTargetCol = targetCol
    let shiftedTargetRow = targetRow

    const expandLeft = Math.max(0, -shiftedTargetCol)
    const expandTop = Math.max(0, -shiftedTargetRow)
    const expandRight = Math.max(0, shiftedTargetCol - (width - 1))
    const expandBottom = Math.max(0, shiftedTargetRow - (height - 1))

    if (expandLeft > 0 || expandTop > 0 || expandRight > 0 || expandBottom > 0) {
      const nextWidth = width + expandLeft + expandRight
      const nextHeight = height + expandTop + expandBottom
      const expanded = new Array<number>(nextWidth * nextHeight).fill(-1)

      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
          expanded[(row + expandTop) * nextWidth + (col + expandLeft)] = newMap[row * width + col]
        }
      }

      newMap = expanded
      width = nextWidth
      height = nextHeight
      shiftedTargetCol += expandLeft
      shiftedTargetRow += expandTop
      nextOrigin = {
        col: nextOrigin.col - expandLeft,
        row: nextOrigin.row - expandTop,
      }
    }

    const shiftedOldPos = oldPos >= 0
      ? (oldRow + expandTop) * width + (oldCol + expandLeft)
      : -1
    const targetIdx = shiftedTargetRow * width + shiftedTargetCol

    if (targetIdx < 0 || targetIdx >= newMap.length) return

    if (shiftedOldPos === targetIdx) {
      const trimmed = trimMatrixToOccupiedBounds({ width, height, map: newMap }, nextOrigin)
      set({
        editingMatrix: trimmed.matrix,
        editingGridSize: { cols: trimmed.matrix.width, rows: trimmed.matrix.height },
        editingOrigin: trimmed.origin,
      })
      return
    }

    const displacedLed = newMap[targetIdx]
    if (displacedLed >= editingAvailableLedCount) return

    if (shiftedOldPos >= 0) {
      newMap[shiftedOldPos] = displacedLed >= 0 ? displacedLed : -1
    }
    newMap[targetIdx] = ledIndex

    const trimmed = trimMatrixToOccupiedBounds({ width, height, map: newMap }, nextOrigin)

    set({
      editingMatrix: trimmed.matrix,
      editingGridSize: { cols: trimmed.matrix.width, rows: trimmed.matrix.height },
      editingOrigin: trimmed.origin,
    })
  },
}), {
  partialize: (state) => ({
    placedDevices: state.placedDevices,
    canvasBounds: state.canvasBounds,
    snapToGrid: state.snapToGrid,
  }),
  limit: TEMPORAL_LIMIT,
  equality: (a, b) => JSON.stringify(a) === JSON.stringify(b),
}))

export const getTemporalStore = () =>
  (useCanvasStore as unknown as { temporal: StoreApi<TemporalState<CanvasHistoryState>> }).temporal

export function beginCanvasHistoryBatch() {
  if (historyBatchDepth === 0) {
    const { placedDevices, canvasBounds, snapToGrid } = useCanvasStore.getState()
    historyBatchStart = structuredClone({ placedDevices, canvasBounds, snapToGrid })
    getTemporalStore().getState().pause()
  }
  historyBatchDepth += 1
}

export function endCanvasHistoryBatch() {
  if (historyBatchDepth === 0) return
  historyBatchDepth -= 1
  if (historyBatchDepth > 0) return

  const temporal = getTemporalStore()
  const start = historyBatchStart
  historyBatchStart = null
  temporal.getState().resume()

  if (!start) return

  const { placedDevices, canvasBounds, snapToGrid } = useCanvasStore.getState()
  if (JSON.stringify(start) === JSON.stringify({ placedDevices, canvasBounds, snapToGrid })) return

  temporal.setState(s => ({
    pastStates: trimPastStates([...s.pastStates, start]),
    futureStates: [],
  }))
}

export function resetCanvasHistoryBatch() {
  historyBatchDepth = 0
  historyBatchStart = null
  getTemporalStore().getState().resume()
}
