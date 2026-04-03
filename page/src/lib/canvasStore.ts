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
  updateCanvasBounds: (patch: Partial<CanvasBounds>) => void
  setSnapToGrid: (snap: boolean) => void
  toggleSnapToGrid: () => void
  setSelectedId: (id: string | null) => void

  /** Replace local state with data from a backend layout snapshot */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hydrateFromLayout: (layoutId: string, canvas: CanvasBounds, placements: any[], snapToGrid: boolean) => void
}

type CanvasHistoryState = Pick<CanvasState, 'placedDevices' | 'canvasBounds' | 'snapToGrid'>

let nextId = 1
const MIN_CANVAS_SIDE = 1
const TEMPORAL_LIMIT = 50
const DEFAULT_CANVAS_BOUNDS: CanvasBounds = {
  x: 0,
  y: 0,
  width: 64,
  height: 64,
}

let historyBatchDepth = 0
let historyBatchStart: CanvasHistoryState | null = null

function computeDefaultSize(ledsCount: number, matrix: Matrix | null): { width: number; height: number } {
  if (matrix && matrix.width > 0 && matrix.height > 0) {
    return { width: matrix.width, height: matrix.height }
  }
  if (ledsCount <= 0) return { width: 1, height: 1 }
  return { width: ledsCount, height: 1 }
}

function makeKey(deviceId: string, outputId: string, segmentId?: string) {
  return `${deviceId}::${outputId}::${segmentId ?? ''}`
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
  return {
    id: p.id ?? `pd-${nextId++}`,
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
    })

    // Clear history and resume tracking after hydration
    temporal.getState().clear()
    temporal.getState().resume()
  },

  addDevice(info) {
    const state = get()
    const key = makeKey(info.deviceId, info.outputId, info.segmentId)
    if (state.placedDevices.some(d => makeKey(d.deviceId, d.outputId, d.segmentId) === key)) return

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
          id: `pd-${nextId++}`,
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
