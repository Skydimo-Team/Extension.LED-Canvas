/** Types for Studio layout import from Skydimo-OpenRGB */

export interface StudioDeviceCandidate {
  device_id: string
  score: number
  device_name: string
  serial_id: string
}

export interface StudioOutputCandidate {
  output_id: string
  output_name: string
  segments: Array<{ id: string; name?: string; leds_count?: number }>
  leds_count: number
}

export interface StudioZoneMatch {
  member_key: string
  zone_name: string
  segment_index: number
  output_candidates: StudioOutputCandidate[]
  auto_match_output: { output_id: string; segment_id: string | null } | null
  old_leds_count: number
  new_leds_count: number
  brightness: number
}

export interface StudioDeviceMatch {
  old_device_key: string
  vendor: string
  name: string
  serial: string
  candidates: StudioDeviceCandidate[]
  auto_match: StudioDeviceCandidate | null
  zones: StudioZoneMatch[]
}

export interface StudioTabInfo {
  tab_serial: string
  name: string
  zones_count: number
  device_matches: StudioDeviceMatch[]
  has_overrides: boolean
}

export interface StudioScanResult {
  tabs: StudioTabInfo[]
  devices: unknown[]
  error?: string
  path?: string
}

export interface StudioResolvedMatch {
  member_key: string
  device_id: string
  output_id: string
  segment_id: string | null
}

export interface StudioImportResult {
  success: boolean
  layout_id?: string
  error?: string
  detail?: string
}
