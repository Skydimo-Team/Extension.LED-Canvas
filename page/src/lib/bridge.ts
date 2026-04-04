/**
 * Plugin page bridge — manages WebSocket connection with the Skydimo core,
 * handles device data synchronization and multi-layout state.
 */
import { create } from 'zustand'
import { setLocale } from './i18n'
import type { Device, LedColor, Output, TreeDevice } from '@/types'
import type { CanvasBounds, PlacedDevice } from './canvasStore'

/* ── Globals injected by the host (Tauri init-script) ── */
interface SkydimoExtPage {
  extId: string
  wsUrl: string
  locale?: string
}
declare global {
  interface Window {
    __SKYDIMO_EXT_PAGE__?: Partial<SkydimoExtPage>
  }
}

const PAGE: SkydimoExtPage = {
  extId: window.__SKYDIMO_EXT_PAGE__?.extId ?? 'led_canvas',
  wsUrl: window.__SKYDIMO_EXT_PAGE__?.wsUrl ?? 'ws://127.0.0.1:42070',
}

/* ── Layout types ── */
export interface LocalizedText {
  raw?: string
  byLocale?: Record<string, string>
}

export interface EffectParamDependency {
  key: string
  equals?: unknown
  not_equals?: unknown
  behavior?: 'hide' | 'disable'
}

export interface EffectOptionInfo {
  label?: LocalizedText
  value: unknown
}

export interface EffectParamInfo {
  type: string
  key: string
  label?: LocalizedText
  group?: LocalizedText
  dependency?: EffectParamDependency | null
  default?: unknown
  min?: number
  max?: number
  step?: number
  fixedCount?: number | null
  minCount?: number | null
  maxCount?: number | null
  options?: EffectOptionInfo[]
}

export interface EffectInfo {
  id: string
  name?: LocalizedText
  description?: LocalizedText
  group?: LocalizedText
  icon?: string
  params: EffectParamInfo[]
}

export interface LayoutVirtualDeviceState {
  power_on: boolean
  effect_id: string | null
  effect_params: Record<string, unknown>
  raw_device: unknown | null
  raw_output: unknown | null
}

export interface LayoutInfo {
  id: string
  name: string
  registered: boolean
  canvas: CanvasBounds
  snap_to_grid: boolean
  placements: PlacedDevice[]
  virtual_device: LayoutVirtualDeviceState
}

/* ── Store types ── */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

interface BridgeState {
  status: ConnectionStatus
  devices: TreeDevice[]
  liveFramesByPort: Record<string, LedColor[]>
  effects: EffectInfo[]
  /** All layouts from the backend */
  layouts: LayoutInfo[]
  /** Currently active layout id */
  activeLayoutId: string | null

  connect: () => void
  requestDevices: () => void
  requestEffects: () => void
  requestFullState: () => void
  switchLayout: (layoutId: string) => void
  createLayout: (name: string) => void
  deleteLayout: (layoutId: string) => void
  renameLayout: (layoutId: string, name: string) => void
  registerCanvas: (layoutId: string, width: number, height: number) => void
  unregisterCanvas: (layoutId: string) => void
  syncPlacements: (layoutId: string, placed: PlacedDevice[], canvasBounds: CanvasBounds) => void
  updatePlacementBrightness: (layoutId: string, placementId: string, brightness: number) => void
  updateSnap: (layoutId: string, snap: boolean) => void
  setVirtualDevicePower: (layoutId: string, powerOn: boolean) => void
  setVirtualDeviceEffect: (layoutId: string, effectId: string | null) => void
  updateVirtualDeviceEffectParams: (layoutId: string, params: Record<string, unknown>) => void
  resetVirtualDeviceEffectParams: (layoutId: string) => void
  disconnect: () => void
}

/* ── Internal WS handling ── */
let ws: WebSocket | null = null
let rpcId = 1
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastDeviceHash = ''

function send(method: string, params: Record<string, unknown>) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }))
}

function sendToExt(data: Record<string, unknown>) {
  send('ext_page_send', { extId: PAGE.extId, data })
}

function normalizeOutputs(outputs: unknown): TreeDevice['outputs'] {
  const rawOutputs: Output[] = Array.isArray(outputs) ? outputs : []
  return rawOutputs.map(output => ({
    ...output,
    segments: Array.isArray(output.segments) ? output.segments : [],
  }))
}

function normalizeDevices(devices: unknown): TreeDevice[] {
  const rawDevices: Device[] = Array.isArray(devices) ? devices : []
  return rawDevices.map(device => ({
    ...device,
    outputs: normalizeOutputs(device.outputs),
  }))
}

function normalizeLedColors(colors: unknown): LedColor[] {
  const rawColors = Array.isArray(colors) ? colors : []
  return rawColors.flatMap((color) => {
    if (!color || typeof color !== 'object') return []

    const r = Number((color as LedColor).r)
    const g = Number((color as LedColor).g)
    const b = Number((color as LedColor).b)
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return []

    return [{
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
    }]
  })
}

function normalizeVirtualDeviceState(value: unknown): LayoutVirtualDeviceState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const effectId = typeof raw.effect_id === 'string' && raw.effect_id.trim().length > 0
    ? raw.effect_id
    : null
  const effectParams = raw.effect_params && typeof raw.effect_params === 'object' && !Array.isArray(raw.effect_params)
    ? raw.effect_params as Record<string, unknown>
    : {}

  return {
    power_on: raw.power_on !== false,
    effect_id: effectId,
    effect_params: effectId ? effectParams : {},
    raw_device: raw.raw_device ?? null,
    raw_output: raw.raw_output ?? null,
  }
}

function normalizeLayouts(layouts: unknown): LayoutInfo[] {
  const rawLayouts = Array.isArray(layouts) ? layouts : []
  return rawLayouts.flatMap((layout) => {
    if (!layout || typeof layout !== 'object') return []
    const raw = layout as LayoutInfo & Record<string, unknown>
    return [{
      ...raw,
      placements: Array.isArray(raw.placements) ? raw.placements : [],
      virtual_device: normalizeVirtualDeviceState(raw.virtual_device),
    }]
  })
}

function normalizeEffects(effects: unknown): EffectInfo[] {
  const rawEffects = Array.isArray(effects) ? effects : []
  return rawEffects.flatMap((effect) => {
    if (!effect || typeof effect !== 'object') return []
    const raw = effect as EffectInfo & Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : null
    if (!id) return []

    return [{
      ...raw,
      id,
      params: Array.isArray(raw.params) ? raw.params : [],
    }]
  })
}

export const useBridgeStore = create<BridgeState>((set, get) => {
  function applyDeviceSnapshot(devices: unknown) {
    const normalized = normalizeDevices(devices)
    const hash = JSON.stringify(normalized)
    if (hash === lastDeviceHash) return
    lastDeviceHash = hash
    set(s => {
      const knownPorts = new Set(
        normalized
          .map(device => device.port)
          .filter((port): port is string => typeof port === 'string' && port.length > 0),
      )

      return {
        devices: normalized,
        liveFramesByPort: Object.fromEntries(
          Object.entries(s.liveFramesByPort).filter(([port]) => knownPorts.has(port)),
        ),
      }
    })
  }

  function hasAnyRegistered(layouts: LayoutInfo[]): boolean {
    return layouts.some(l => l.registered)
  }

  function applyFullState(data: Record<string, unknown>) {
    if (!data) return
    const layouts = normalizeLayouts(data.layouts)
    set({
      layouts,
      activeLayoutId: (data.active_layout_id as string | undefined) ?? layouts[0]?.id ?? null,
      ...(!hasAnyRegistered(layouts) && { liveFramesByPort: {} }),
    })
  }

  function applyLayoutStatus(data: Record<string, unknown>) {
    if (!data?.layout) return
    const [updated] = normalizeLayouts([data.layout])
    if (!updated) return
    set(s => {
      const existingIndex = s.layouts.findIndex(l => l.id === updated.id)
      const nextLayouts = existingIndex === -1
        ? [...s.layouts, updated]
        : s.layouts.map(l => l.id === updated.id ? updated : l)
      return {
        layouts: nextLayouts,
        ...(!hasAnyRegistered(nextLayouts) && { liveFramesByPort: {} }),
      }
    })
  }

  function doConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    set({ status: 'connecting' })
    ws = new WebSocket(PAGE.wsUrl)

    ws.onopen = () => {
      set({ status: 'connected' })
      get().requestDevices()
      get().requestEffects()
      get().requestFullState()
    }

    ws.onmessage = (evt) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(evt.data) } catch { return }

      /* Event notifications */
      if (msg.method === 'event' && msg.params) {
        const params = msg.params as Record<string, unknown>
        const { event, data } = params as { event: string; data: Record<string, unknown> }

        if (event === 'device-led-update') {
          if (!hasAnyRegistered(get().layouts)) return

          const payload = data as Record<string, unknown>
          const port = typeof payload.port === 'string' ? payload.port : null
          if (!port) return

          set(s => ({
            liveFramesByPort: {
              ...s.liveFramesByPort,
              [port]: normalizeLedColors(payload.colors),
            },
          }))
          return
        }

        if (event === 'locale-changed') {
          const locale = typeof data?.locale === 'string' ? data.locale : null
          if (locale) setLocale(locale)
          return
        }

        if (event === `ext-page-message:${PAGE.extId}`) {
          if (data?.type === 'devices') {
            applyDeviceSnapshot((data as Record<string, unknown>).data)
          }
          if (data?.type === 'full_state') {
            applyFullState(data as Record<string, unknown>)
          }
          if (data?.type === 'layout_status') {
            applyLayoutStatus(data as Record<string, unknown>)
          }
          if (data?.type === 'effects_catalog') {
            set({ effects: normalizeEffects((data as Record<string, unknown>).effects) })
          }
        }
      }
    }

    ws.onclose = () => {
      set({
        status: 'disconnected',
        liveFramesByPort: {},
      })
      reconnectTimer = setTimeout(doConnect, 3000)
    }

    ws.onerror = () => { /* onclose will fire */ }
  }

  return {
    status: 'disconnected',
    devices: [],
    liveFramesByPort: {},
    effects: [],
    layouts: [],
    activeLayoutId: null,

    connect: doConnect,

    requestDevices() {
      sendToExt({ type: 'get_devices' })
    },

    requestEffects() {
      sendToExt({ type: 'get_effects_catalog' })
    },

    requestFullState() {
      sendToExt({ type: 'get_full_state' })
    },

    switchLayout(layoutId) {
      set({ activeLayoutId: layoutId })
      sendToExt({ type: 'switch_layout', layout_id: layoutId })
    },

    createLayout(name) {
      sendToExt({ type: 'create_layout', name })
    },

    deleteLayout(layoutId) {
      sendToExt({ type: 'delete_layout', layout_id: layoutId })
    },

    renameLayout(layoutId, name) {
      sendToExt({ type: 'rename_layout', layout_id: layoutId, name })
    },

    registerCanvas(layoutId, width, height) {
      sendToExt({ type: 'register_canvas', layout_id: layoutId, width, height })
    },

    unregisterCanvas(layoutId) {
      sendToExt({ type: 'unregister_canvas', layout_id: layoutId })
    },

    syncPlacements(layoutId, placed, canvasBounds) {
      const canvasX = Number.isFinite(canvasBounds.x) ? canvasBounds.x : 0
      const canvasY = Number.isFinite(canvasBounds.y) ? canvasBounds.y : 0

      const data = placed.map(d => ({
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
        ledsCount: d.ledsCount, matrix: d.matrix,
        brightness: d.brightness ?? 100,
        snapshot: d.snapshot,
      }))

      sendToExt({
        type: 'update_placements',
        layout_id: layoutId,
        canvas: {
          width: canvasBounds.width,
          height: canvasBounds.height,
        },
        data,
      })
    },

    updatePlacementBrightness(layoutId, placementId, brightness) {
      sendToExt({
        type: 'update_placement_brightness',
        layout_id: layoutId,
        placement_id: placementId,
        brightness: Math.max(0, Math.min(100, Math.round(brightness))),
      })
    },

    updateSnap(layoutId, snap) {
      sendToExt({ type: 'update_snap', layout_id: layoutId, snap_to_grid: snap })
    },

    setVirtualDevicePower(layoutId, powerOn) {
      sendToExt({ type: 'set_layout_virtual_power', layout_id: layoutId, power_on: powerOn })
    },

    setVirtualDeviceEffect(layoutId, effectId) {
      sendToExt({ type: 'set_layout_virtual_effect', layout_id: layoutId, effect_id: effectId })
    },

    updateVirtualDeviceEffectParams(layoutId, params) {
      sendToExt({ type: 'update_layout_virtual_effect_params', layout_id: layoutId, params })
    },

    resetVirtualDeviceEffectParams(layoutId) {
      sendToExt({ type: 'reset_layout_virtual_effect_params', layout_id: layoutId })
    },

    disconnect() {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) { ws.close(); ws = null }
      lastDeviceHash = ''
      set({
        status: 'disconnected',
        devices: [],
        liveFramesByPort: {},
        effects: [],
        layouts: [],
        activeLayoutId: null,
      })
    },
  }
})
