/** Matrix layout information for a zone/segment */
export interface Matrix {
  width: number
  height: number
  /** Row-major map: -1 means no LED at that cell, >= 0 is the physical LED index */
  map: number[]
}

export interface LedColor {
  r: number
  g: number
  b: number
}

/** Snapshot of a device output/segment at the time it was added to the grid */
export interface PlacementSnapshot {
  ledsCount: number
  matrix?: Matrix | null
  name?: string
}

/** A segment within an output (sub-zone) */
export interface Segment {
  id: string
  name?: string
  segment_type?: string
  leds_count?: number
  matrix?: Matrix | null
}

/** A device output endpoint */
export interface Output {
  id: string
  name?: string
  output_type?: string
  leds_count?: number
  matrix?: Matrix | null
  segments?: Segment[]
}

/** A device returned by the plugin API */
export interface Device {
  id: string
  port?: string
  name?: string
  nickname?: string
  model?: string
  description?: string
  serial_id?: string
  outputs?: Output[]
}

export type TreeDevice = Omit<Device, 'outputs'> & {
  outputs: Array<Omit<Output, 'segments'> & { segments: Segment[] }>
}

/** Canvas bounds for a layout */
export interface CanvasBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A placement entry (serialized to/from backend) */
export interface PlacementData {
  id?: string
  deviceId: string
  port?: string
  outputId: string
  segmentId?: string
  x: number
  y: number
  width: number
  height: number
  /** Rotation angle in degrees (0–360, clockwise) */
  rotation?: number
  ledsCount: number
  matrix: Matrix | null
  /** Per-placement brightness (0–100, default 100) */
  brightness?: number
  /** Snapshot captured when the device was first added to the grid */
  snapshot?: PlacementSnapshot | null
  /** True if the live device state differs from the snapshot (needs re-add) */
  stale?: boolean
  blockedLedIndices?: number[]
  blockedLedCount?: number
  availableLedCount?: number
}

/** A layout as received from the backend */
export interface Layout {
  id: string
  name: string
  registered: boolean
  canvas: CanvasBounds
  snap_to_grid: boolean
  placements: PlacementData[]
}
