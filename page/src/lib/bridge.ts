/**
 * Plugin page bridge — manages WebSocket connection with the Skydimo core,
 * handles device data synchronization and multi-layout state.
 */
import { create } from 'zustand'
import { setLocale } from './i18n'
import type { Device, LedColor, Output, TreeDevice } from '@/types'
import type { CanvasBounds, PlacedDevice } from './canvasStore'

/* ── Connection info resolution ── */
// Sources (in priority order):
//  1. window.__SKYDIMO_EXT_PAGE__  — injected by Tauri bootstrap script (path mode)
//  2. URL query params             — set by UI iframe loader (url mode) or manual dev
//  3. Hardcoded fallback

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

const _params = new URLSearchParams(window.location.search)

const PAGE: SkydimoExtPage = {
  extId: window.__SKYDIMO_EXT_PAGE__?.extId ?? _params.get('extId') ?? 'led_canvas',
  wsUrl: window.__SKYDIMO_EXT_PAGE__?.wsUrl ?? _params.get('wsUrl') ?? 'ws://127.0.0.1:42070',
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
  paused: boolean
  effect_id: string | null
  effect_params: Record<string, unknown>
}

export interface LayoutPreviewFrame {
  canvas: LedColor[]
  placementsById: Record<string, LedColor[]>
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
  previewByLayoutId: Record<string, LayoutPreviewFrame>
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
  previewPlacements: (layoutId: string, placed: PlacedDevice[], canvasBounds: CanvasBounds) => void
  clearPlacementPreview: (layoutId: string) => void
  updatePlacementBrightness: (layoutId: string, placementId: string, brightness: number) => void
  updateSnap: (layoutId: string, snap: boolean) => void
  setVirtualDevicePower: (layoutId: string, powerOn: boolean) => void
  setVirtualDevicePaused: (layoutId: string, paused: boolean) => void
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

function normalizeLayouts(layouts: unknown): LayoutInfo[] {
  if (!Array.isArray(layouts)) return []
  return layouts.filter((l): l is LayoutInfo => !!l && typeof l === 'object' && typeof (l as LayoutInfo).id === 'string')
    .map(layout => ({
      ...layout,
      placements: Array.isArray(layout.placements) ? layout.placements : [],
      virtual_device: {
        power_on: layout.virtual_device?.power_on !== false,
        paused: layout.virtual_device?.paused === true,
        effect_id: layout.virtual_device?.effect_id ?? null,
        effect_params: layout.virtual_device?.effect_params ?? {},
      },
    }))
}

function normalizeEffects(effects: unknown): EffectInfo[] {
  if (!Array.isArray(effects)) return []
  return effects.filter((e): e is EffectInfo => !!e && typeof e === 'object' && typeof (e as EffectInfo).id === 'string')
    .map(effect => ({
      ...effect,
      params: Array.isArray(effect.params) ? effect.params : [],
    }))
}

function buildPlacementSyncPayload(placed: PlacedDevice[], canvasBounds: CanvasBounds) {
  const canvasX = Number.isFinite(canvasBounds.x) ? canvasBounds.x : 0
  const canvasY = Number.isFinite(canvasBounds.y) ? canvasBounds.y : 0

  return {
    canvas: {
      width: canvasBounds.width,
      height: canvasBounds.height,
    },
    data: placed.map(d => ({
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
  }
}

export const useBridgeStore = create<BridgeState>((set, get) => {
  function applyDeviceSnapshot(devices: unknown) {
    const normalized = normalizeDevices(devices)
    const hash = JSON.stringify(normalized)
    if (hash === lastDeviceHash) return
    lastDeviceHash = hash
    set({ devices: normalized })
  }

  function normalizePlacementPreviewMap(placements: unknown): Record<string, LedColor[]> {
    if (!Array.isArray(placements)) return {}

    return placements.reduce<Record<string, LedColor[]>>((acc, placement) => {
      if (!placement || typeof placement !== 'object') return acc

      const payload = placement as Record<string, unknown>
      const placementId = typeof payload.placement_id === 'string' ? payload.placement_id : null
      if (!placementId) return acc

      acc[placementId] = normalizeLedColors(payload.colors)
      return acc
    }, {})
  }

  function retainRegisteredPreviews(
    layouts: LayoutInfo[],
    previewByLayoutId: Record<string, LayoutPreviewFrame>,
  ): Record<string, LayoutPreviewFrame> {
    const registeredIds = new Set(
      layouts
        .filter(layout => layout.registered)
        .map(layout => layout.id),
    )

    return Object.fromEntries(
      Object.entries(previewByLayoutId).filter(([layoutId]) => registeredIds.has(layoutId)),
    )
  }

  function applyPreviewFrame(data: Record<string, unknown>) {
    const layoutId = typeof data.layout_id === 'string' ? data.layout_id : null
    if (!layoutId) return

    set(s => ({
      previewByLayoutId: {
        ...s.previewByLayoutId,
        [layoutId]: {
          canvas: normalizeLedColors(data.canvas),
          placementsById: normalizePlacementPreviewMap(data.placements),
        },
      },
    }))
  }

  function applyFullState(data: Record<string, unknown>) {
    if (!data) return
    const layouts = normalizeLayouts(data.layouts)
    set(s => ({
      layouts,
      activeLayoutId: (data.active_layout_id as string | undefined) ?? layouts[0]?.id ?? null,
      previewByLayoutId: retainRegisteredPreviews(layouts, s.previewByLayoutId),
    }))
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

      const nextPreviews = updated.registered
        ? retainRegisteredPreviews(nextLayouts, s.previewByLayoutId)
        : Object.fromEntries(
          Object.entries(s.previewByLayoutId).filter(([layoutId]) => layoutId !== updated.id),
        )

      return {
        layouts: nextLayouts,
        previewByLayoutId: nextPreviews,
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
          if (data?.type === 'preview_frame') {
            applyPreviewFrame(data as Record<string, unknown>)
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
        previewByLayoutId: {},
      })
      reconnectTimer = setTimeout(doConnect, 3000)
    }

    ws.onerror = () => { /* onclose will fire */ }
  }

  return {
    status: 'disconnected',
    devices: [],
    previewByLayoutId: {},
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
      const payload = buildPlacementSyncPayload(placed, canvasBounds)

      sendToExt({
        type: 'update_placements',
        layout_id: layoutId,
        ...payload,
      })
    },

    previewPlacements(layoutId, placed, canvasBounds) {
      const payload = buildPlacementSyncPayload(placed, canvasBounds)

      sendToExt({
        type: 'preview_placements',
        layout_id: layoutId,
        ...payload,
      })
    },

    clearPlacementPreview(layoutId) {
      sendToExt({ type: 'clear_placement_preview', layout_id: layoutId })
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

    setVirtualDevicePaused(layoutId, paused) {
      sendToExt({ type: 'set_layout_virtual_paused', layout_id: layoutId, paused })
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
        previewByLayoutId: {},
        effects: [],
        layouts: [],
        activeLayoutId: null,
      })
    },
  }
})
