use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const CANVAS_PORT_PREFIX: &str = "ext:led_canvas:canvas";
pub const CANVAS_OUTPUT_ID: &str = "canvas";
pub const CANVAS_MANUFACTURER: &str = "LedCanvas";
pub const DEFAULT_GRID_W: usize = 64;
pub const DEFAULT_GRID_H: usize = 64;
const MAX_GRID_SIDE: usize = 256;
const MAX_LAYOUT_NAME_CHARS: usize = 64;
const LAYOUT_ID_LENGTH: usize = 9;
const LAYOUT_ID_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const EMPTY_MATRIX_CELL: i64 = -1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_config_version")]
    pub version: u32,
    pub active_layout_id: String,
    pub layouts: Vec<Layout>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layout {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub registered: bool,
    pub canvas: Canvas,
    #[serde(default)]
    pub placements: Vec<Placement>,
    #[serde(default)]
    pub snap_to_grid: bool,
    #[serde(default)]
    pub virtual_device: VirtualDevice,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Canvas {
    pub width: usize,
    pub height: usize,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Placement {
    pub id: String,
    #[serde(rename = "deviceId", skip_serializing_if = "Option::is_none", default)]
    pub device_id: Option<String>,
    #[serde(rename = "legacyPort", skip_serializing_if = "Option::is_none", default, alias = "port")]
    pub legacy_port: Option<String>,
    #[serde(rename = "outputId")]
    pub output_id: String,
    #[serde(rename = "segmentId", skip_serializing_if = "Option::is_none", default)]
    pub segment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(rename = "ledsCount", alias = "leds_count")]
    pub leds_count: usize,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub matrix: Option<Matrix>,
    #[serde(default = "default_brightness")]
    pub brightness: u8,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub snapshot: Option<PlacementSnapshot>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlacementSnapshot {
    #[serde(rename = "ledsCount", alias = "leds_count")]
    pub leds_count: usize,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub matrix: Option<Matrix>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(rename = "customMatrix", skip_serializing_if = "Option::is_none", default)]
    pub custom_matrix: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Matrix {
    pub width: usize,
    pub height: usize,
    pub map: Vec<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VirtualDevice {
    pub power_on: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effect_id: Option<String>,
    #[serde(default)]
    pub effect_params: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub struct RuntimePlacement {
    pub id: String,
    pub port: String,
    pub output_id: String,
    pub segment_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub leds_count: usize,
    pub matrix: Option<Matrix>,
    pub brightness: u8,
    pub local_indices: Vec<usize>,
    pub actual_indices: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct PlacementStatus {
    pub blocked_led_indices: Vec<usize>,
    pub blocked_led_count: usize,
    pub available_led_count: usize,
}

#[derive(Clone, Debug, Default)]
pub struct DeviceLookup {
    by_id: HashMap<String, Value>,
    by_port: HashMap<String, Value>,
}

pub struct IdGenerator {
    state: u64,
}

impl Default for VirtualDevice {
    fn default() -> Self {
        Self {
            power_on: true,
            paused: false,
            effect_id: None,
            effect_params: Map::new(),
        }
    }
}

impl IdGenerator {
    pub fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0xA5A5_5A5A_F00D_CAFE);
        let stack_mix = (&nanos as *const u64 as usize) as u64;
        Self {
            state: nanos ^ stack_mix.rotate_left(17) ^ 0x9E37_79B9_7F4A_7C15,
        }
    }

    pub fn next_layout_id(&mut self, existing_ids: &mut HashSet<String>) -> String {
        loop {
            let mut bytes = [0u8; LAYOUT_ID_LENGTH];
            for byte in &mut bytes {
                *byte = LAYOUT_ID_CHARS[(self.next_u64() as usize) % LAYOUT_ID_CHARS.len()];
            }
            let candidate = String::from_utf8_lossy(&bytes).into_owned();
            if existing_ids.insert(candidate.clone()) {
                return candidate;
            }
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 7;
        x ^= x >> 9;
        x = x.wrapping_mul(0xD6E8_FEB8_6659_FD93);
        self.state = x;
        x
    }
}

impl DeviceLookup {
    pub fn from_devices(devices: &Value) -> Self {
        let mut lookup = Self::default();
        let Some(devices) = devices.as_array() else {
            return lookup;
        };

        for device in devices {
            if !device.is_object() || is_canvas_device(device) {
                continue;
            }
            if let Some(id) = string_value(device, "id") {
                lookup.by_id.entry(id).or_insert_with(|| device.clone());
            }
            if let Some(port) = string_value(device, "port") {
                lookup.by_port.insert(port, device.clone());
            }
        }

        lookup
    }

    pub fn device_by_id(&self, id: &str) -> Option<&Value> {
        self.by_id.get(id)
    }

    pub fn device_by_port(&self, port: &str) -> Option<&Value> {
        self.by_port.get(port)
    }
}

pub fn default_config(rng: &mut IdGenerator) -> Config {
    let mut ids = HashSet::new();
    let layout_id = rng.next_layout_id(&mut ids);
    Config {
        version: default_config_version(),
        active_layout_id: layout_id.clone(),
        layouts: vec![Layout {
            id: layout_id,
            name: "Default".to_string(),
            registered: false,
            canvas: Canvas {
                width: DEFAULT_GRID_W,
                height: DEFAULT_GRID_H,
                x: 0.0,
                y: 0.0,
            },
            placements: Vec::new(),
            snap_to_grid: false,
            virtual_device: VirtualDevice::default(),
        }],
    }
}

pub fn normalize_config(raw: Value, lookup: &DeviceLookup, rng: &mut IdGenerator) -> Config {
    let version = raw.get("version").and_then(Value::as_u64).unwrap_or(default_config_version() as u64) as u32;
    let raw_layouts = raw.get("layouts").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut existing_ids = HashSet::new();
    let mut layouts = Vec::with_capacity(raw_layouts.len().max(1));

    for layout in raw_layouts {
        layouts.push(normalize_layout(layout, &mut existing_ids, lookup, rng));
    }

    if layouts.is_empty() {
        return default_config(rng);
    }

    let active = raw
        .get("active_layout_id")
        .and_then(Value::as_str)
        .filter(|id| layouts.iter().any(|layout| layout.id == *id))
        .map(str::to_string)
        .unwrap_or_else(|| layouts[0].id.clone());

    Config {
        version,
        active_layout_id: active,
        layouts,
    }
}

pub fn normalize_layout(
    raw: Value,
    existing_ids: &mut HashSet<String>,
    lookup: &DeviceLookup,
    rng: &mut IdGenerator,
) -> Layout {
    let preferred_id = string_value_any(&raw, &["id", "serial_id", "serial"]);
    let id = if preferred_id
        .as_deref()
        .is_some_and(|id| is_valid_layout_id(id) && !existing_ids.contains(id))
    {
        let id = preferred_id.unwrap();
        existing_ids.insert(id.clone());
        id
    } else {
        rng.next_layout_id(existing_ids)
    };

    let name = sanitize_layout_name(raw.get("name").and_then(Value::as_str), Some(id.as_str()));
    let canvas_value = raw.get("canvas").unwrap_or(&Value::Null);
    let placements_value = raw.get("placements").unwrap_or(&Value::Null);

    Layout {
        id,
        name,
        registered: raw.get("registered").and_then(Value::as_bool).unwrap_or(false),
        canvas: Canvas {
            width: sanitize_canvas_side(canvas_value.get("width"), DEFAULT_GRID_W),
            height: sanitize_canvas_side(canvas_value.get("height"), DEFAULT_GRID_H),
            x: number_value(canvas_value.get("x")).unwrap_or(0.0),
            y: number_value(canvas_value.get("y")).unwrap_or(0.0),
        },
        placements: normalize_placements(placements_value, lookup, rng),
        snap_to_grid: raw.get("snap_to_grid").and_then(Value::as_bool).unwrap_or(false),
        virtual_device: normalize_virtual_device(raw.get("virtual_device")),
    }
}

pub fn normalize_placements(value: &Value, lookup: &DeviceLookup, rng: &mut IdGenerator) -> Vec<Placement> {
    let Some(values) = value.as_array() else {
        return Vec::new();
    };
    let mut normalized = Vec::with_capacity(values.len());
    let mut seen_ids = HashSet::new();

    for value in values {
        let Some(output_id) = string_value(value, "outputId") else {
            continue;
        };
        if value.get("deviceId").is_none()
            && value.get("port").is_none()
            && value.get("legacyPort").is_none()
        {
            continue;
        }

        let preferred_id = string_value(value, "id");
        let id = if preferred_id
            .as_deref()
            .is_some_and(|id| is_valid_layout_id(id) && !seen_ids.contains(id))
        {
            let id = preferred_id.unwrap();
            seen_ids.insert(id.clone());
            id
        } else {
            rng.next_layout_id(&mut seen_ids)
        };

        let raw_count = usize_value_any(value, &["ledsCount", "leds_count"]).unwrap_or(0);
        let device_id = resolve_device_id(
            lookup,
            string_value(value, "deviceId").as_deref(),
            string_value(value, "port")
                .or_else(|| string_value(value, "legacyPort"))
                .as_deref(),
        );
        let mut legacy_port = string_value(value, "legacyPort")
            .filter(|value| !value.is_empty())
            .or_else(|| string_value(value, "port").filter(|value| !value.is_empty()));
        if device_id.is_some() {
            legacy_port = None;
        }
        let segment_id = string_value(value, "segmentId").filter(|segment| !segment.is_empty());
        let mut snapshot = normalize_snapshot(value.get("snapshot"), raw_count);
        if snapshot.is_none() {
            snapshot = build_snapshot_from_device(lookup, device_id.as_deref(), &output_id, segment_id.as_deref());
        }
        let authoritative_leds = snapshot
            .as_ref()
            .map(|snapshot| snapshot.leds_count)
            .filter(|count| *count > 0)
            .unwrap_or(raw_count);

        normalized.push(Placement {
            id,
            device_id,
            legacy_port,
            output_id,
            segment_id,
            name: string_value(value, "name"),
            x: number_value(value.get("x")).unwrap_or(0.0),
            y: number_value(value.get("y")).unwrap_or(0.0),
            width: number_value(value.get("width")).unwrap_or(1.0).max(1.0),
            height: number_value(value.get("height")).unwrap_or(1.0).max(1.0),
            rotation: normalize_rotation(number_value(value.get("rotation")).or_else(|| number_value(value.get("angle")))),
            leds_count: authoritative_leds,
            matrix: normalize_matrix(value.get("matrix"), authoritative_leds),
            brightness: sanitize_brightness(value.get("brightness")),
            snapshot,
        });
    }

    normalized
}

pub fn build_preview_override(
    layout: &Layout,
    placements: &Value,
    canvas: Option<&Value>,
    lookup: &DeviceLookup,
    rng: &mut IdGenerator,
) -> (Vec<Placement>, Canvas) {
    let canvas_value = canvas.unwrap_or(&Value::Null);
    (
        normalize_placements(placements, lookup, rng),
        Canvas {
            width: sanitize_canvas_side(canvas_value.get("width"), layout.canvas.width),
            height: sanitize_canvas_side(canvas_value.get("height"), layout.canvas.height),
            x: layout.canvas.x,
            y: layout.canvas.y,
        },
    )
}

pub fn runtime_placement(placement: &Placement, lookup: &DeviceLookup) -> Option<RuntimePlacement> {
    let port = resolve_runtime_port(lookup, placement)?;
    let mut base_index = 0usize;
    let mut leds_count = placement.leds_count;

    if let Some(device) = lookup.device_by_port(&port) {
        if let Some(output) = find_output(device, &placement.output_id) {
            let output_leds = usize_value(output.get("leds_count")).unwrap_or(leds_count);
            if let Some(segment_id) = placement.segment_id.as_deref() {
                if let Some(segments) = output.get("segments").and_then(Value::as_array) {
                    let mut offset = 0usize;
                    for segment in segments {
                        let segment_leds = usize_value(segment.get("leds_count")).unwrap_or(0);
                        if string_value(segment, "id").as_deref() == Some(segment_id) {
                            if segment_leds > 0 && (leds_count == 0 || leds_count > segment_leds) {
                                leds_count = segment_leds;
                            }
                            base_index = offset;
                            break;
                        }
                        offset = offset.saturating_add(segment_leds);
                    }
                }
            } else if output_leds > 0 && (leds_count == 0 || leds_count > output_leds) {
                leds_count = output_leds;
            }
        }
    }

    let local_indices = build_local_indices(placement.matrix.as_ref(), leds_count);
    let actual_indices = local_indices
        .iter()
        .map(|local| base_index.saturating_add(*local))
        .collect();

    Some(RuntimePlacement {
        id: placement.id.clone(),
        port,
        output_id: placement.output_id.clone(),
        segment_id: placement.segment_id.clone(),
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        rotation: normalize_rotation(Some(placement.rotation)),
        leds_count,
        matrix: placement.matrix.clone(),
        brightness: placement.brightness,
        local_indices,
        actual_indices,
    })
}

pub fn placement_lock_key(placement: &RuntimePlacement) -> String {
    format!("{}::{}", placement.port, placement.output_id)
}

pub fn placement_routing_key(placement: &RuntimePlacement) -> String {
    let mut key = placement_lock_key(placement);
    if let Some(segment_id) = placement.segment_id.as_deref().filter(|value| !value.is_empty()) {
        key.push_str("::");
        key.push_str(segment_id);
    }
    key
}

pub fn layout_port(layout_id: &str) -> String {
    format!("{CANVAS_PORT_PREFIX}:{layout_id}")
}

pub fn identity_matrix_map(width: usize, height: usize) -> Vec<i64> {
    let total = width.saturating_mul(height);
    (0..total).map(|index| index as i64).collect()
}

pub fn layout_summary(
    layout: &Layout,
    lookup: &DeviceLookup,
    status: Option<&HashMap<String, PlacementStatus>>,
) -> Value {
    let placements = layout
        .placements
        .iter()
        .map(|placement| {
            let runtime = runtime_placement(placement, lookup);
            let placement_status = status.and_then(|status| status.get(&placement.id));
            json!({
                "id": placement.id,
                "deviceId": placement.device_id,
                "port": runtime.as_ref().map(|runtime| runtime.port.clone())
                    .or_else(|| resolve_runtime_port(lookup, placement)),
                "name": placement.name,
                "outputId": placement.output_id,
                "segmentId": placement.segment_id,
                "x": placement.x,
                "y": placement.y,
                "width": placement.width,
                "height": placement.height,
                "rotation": normalize_rotation(Some(placement.rotation)),
                "ledsCount": placement.leds_count,
                "matrix": placement.matrix,
                "brightness": placement.brightness,
                "snapshot": placement.snapshot,
                "stale": is_placement_stale(
                    placement.snapshot.as_ref(),
                    lookup,
                    placement.device_id.as_deref(),
                    &placement.output_id,
                    placement.segment_id.as_deref(),
                ),
                "blockedLedIndices": placement_status
                    .map(|status| status.blocked_led_indices.clone())
                    .unwrap_or_default(),
                "blockedLedCount": placement_status
                    .map(|status| status.blocked_led_count)
                    .unwrap_or(0),
                "availableLedCount": placement_status
                    .map(|status| status.available_led_count)
                    .or_else(|| runtime.as_ref().map(|runtime| runtime.leds_count))
                    .unwrap_or(placement.leds_count),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "id": layout.id,
        "name": layout.name,
        "registered": layout.registered,
        "canvas": layout.canvas,
        "snap_to_grid": layout.snap_to_grid,
        "placements": placements,
        "virtual_device": {
            "power_on": layout.virtual_device.power_on,
            "paused": layout.virtual_device.paused,
            "effect_id": layout.virtual_device.effect_id,
            "effect_params": layout.virtual_device.effect_params,
        },
    })
}

pub fn filter_devices_for_page(devices: &Value) -> Value {
    let filtered = devices
        .as_array()
        .map(|devices| {
            devices
                .iter()
                .filter(|device| device.is_object() && !is_canvas_device(device))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(filtered)
}

pub fn build_default_effect_params(params_schema: &Value) -> Map<String, Value> {
    let mut defaults = Map::new();
    let Some(params) = params_schema.as_array() else {
        return defaults;
    };

    for param in params {
        let Some(key) = string_value(param, "key") else {
            continue;
        };
        if let Some(default) = param.get("default").filter(|value| !value.is_null()) {
            defaults.insert(key, default.clone());
        }
    }

    defaults
}

pub fn sanitize_layout_name(value: Option<&str>, fallback: Option<&str>) -> String {
    for candidate in [value, fallback].into_iter().flatten() {
        let trimmed = candidate.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(MAX_LAYOUT_NAME_CHARS).collect();
        }
    }
    "Canvas".to_string()
}

pub fn sanitize_canvas_side(value: Option<&Value>, fallback: usize) -> usize {
    let raw = value.and_then(number_from_value).unwrap_or(fallback as f64);
    let rounded = (raw + 0.5).floor();
    if !rounded.is_finite() {
        return fallback.clamp(1, MAX_GRID_SIDE);
    }
    (rounded as isize).clamp(1, MAX_GRID_SIDE as isize) as usize
}

pub fn sanitize_brightness(value: Option<&Value>) -> u8 {
    let raw = value.and_then(number_from_value).unwrap_or(100.0);
    if !raw.is_finite() {
        return 100;
    }
    (raw + 0.5).floor().clamp(0.0, 100.0) as u8
}

pub fn normalize_rotation(value: Option<f64>) -> f64 {
    let Some(mut value) = value.filter(|value| value.is_finite()) else {
        return 0.0;
    };
    value %= 360.0;
    if value < 0.0 {
        value += 360.0;
    }
    value
}

pub fn normalize_matrix(value: Option<&Value>, leds_count: usize) -> Option<Matrix> {
    let value = value?;
    let width = sanitize_non_negative_int(value.get("width"), 0);
    let height = sanitize_non_negative_int(value.get("height"), 0);
    if width == 0 || height == 0 {
        return None;
    }
    let total = width.checked_mul(height)?;
    let source = value.get("map").and_then(Value::as_array);
    let mut map = Vec::with_capacity(total);
    for index in 0..total {
        let raw = source
            .and_then(|source| source.get(index))
            .and_then(number_from_value);
        let mapped = raw
            .map(|value| value.floor() as i64)
            .filter(|value| *value >= 0)
            .filter(|value| leds_count == 0 || (*value as usize) < leds_count)
            .unwrap_or(EMPTY_MATRIX_CELL);
        map.push(mapped);
    }
    Some(Matrix { width, height, map })
}

pub fn normalize_snapshot(value: Option<&Value>, _fallback_leds_count: usize) -> Option<PlacementSnapshot> {
    let value = value?;
    if !value.is_object() {
        return None;
    }
    let leds_count = usize_value_any(value, &["ledsCount", "leds_count"]).unwrap_or(0);
    if leds_count == 0 {
        return None;
    }
    Some(PlacementSnapshot {
        leds_count,
        matrix: normalize_matrix(value.get("matrix"), leds_count),
        name: string_value(value, "name"),
        custom_matrix: value
            .get("customMatrix")
            .and_then(Value::as_bool)
            .filter(|value| *value)
            .map(|_| true),
    })
}

pub fn build_snapshot_from_device(
    lookup: &DeviceLookup,
    device_id: Option<&str>,
    output_id: &str,
    segment_id: Option<&str>,
) -> Option<PlacementSnapshot> {
    let device = lookup.device_by_id(device_id?)?;
    let output = find_output(device, output_id)?;

    if let Some(segment_id) = segment_id.filter(|segment| !segment.is_empty()) {
        let segments = output.get("segments").and_then(Value::as_array)?;
        for segment in segments {
            if string_value(segment, "id").as_deref() == Some(segment_id) {
                let leds = usize_value(segment.get("leds_count")).unwrap_or(0);
                return Some(PlacementSnapshot {
                    leds_count: leds,
                    matrix: normalize_matrix(segment.get("matrix"), leds),
                    name: string_value(segment, "name").or_else(|| string_value(output, "name")),
                    custom_matrix: None,
                });
            }
        }
        return None;
    }

    let leds = usize_value(output.get("leds_count")).unwrap_or(0);
    Some(PlacementSnapshot {
        leds_count: leds,
        matrix: normalize_matrix(output.get("matrix"), leds),
        name: string_value(output, "name"),
        custom_matrix: None,
    })
}

pub fn is_placement_stale(
    snapshot: Option<&PlacementSnapshot>,
    lookup: &DeviceLookup,
    device_id: Option<&str>,
    output_id: &str,
    segment_id: Option<&str>,
) -> bool {
    let Some(snapshot) = snapshot else {
        return false;
    };
    let Some(live) = build_snapshot_from_device(lookup, device_id, output_id, segment_id) else {
        return false;
    };
    if snapshot.leds_count != live.leds_count {
        return true;
    }
    if snapshot.custom_matrix.unwrap_or(false) {
        return false;
    }
    match (snapshot.matrix.as_ref(), live.matrix.as_ref()) {
        (None, None) => false,
        (Some(left), Some(right)) => left.width != right.width || left.height != right.height,
        _ => true,
    }
}

pub fn find_output<'a>(device: &'a Value, output_id: &str) -> Option<&'a Value> {
    device
        .get("outputs")
        .and_then(Value::as_array)?
        .iter()
        .find(|output| string_value(output, "id").as_deref() == Some(output_id))
}

pub fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn string_value_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| string_value(value, key))
}

pub fn usize_value(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

pub fn usize_value_any(value: &Value, keys: &[&str]) -> Option<usize> {
    keys.iter().find_map(|key| usize_value(value.get(*key)))
}

pub fn number_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(number_from_value)
}

fn normalize_virtual_device(value: Option<&Value>) -> VirtualDevice {
    let raw = value.filter(|value| value.is_object());
    let effect_id = raw
        .and_then(|value| string_value(value, "effect_id"))
        .filter(|value| !value.is_empty());
    let effect_params = if effect_id.is_some() {
        raw.and_then(|value| value.get("effect_params"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        Map::new()
    };
    VirtualDevice {
        power_on: raw
            .and_then(|value| value.get("power_on"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        paused: raw
            .and_then(|value| value.get("paused"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        effect_id,
        effect_params,
    }
}

fn is_canvas_device(device: &Value) -> bool {
    device
        .get("manufacturer")
        .and_then(Value::as_str)
        .is_some_and(|manufacturer| manufacturer == CANVAS_MANUFACTURER)
}

fn resolve_device_id(lookup: &DeviceLookup, device_id: Option<&str>, port: Option<&str>) -> Option<String> {
    if let Some(device_id) = device_id.filter(|device_id| !device_id.is_empty()) {
        return Some(device_id.to_string());
    }
    let port = port.filter(|port| !port.is_empty())?;
    lookup
        .device_by_port(port)
        .and_then(|device| string_value(device, "id"))
}

fn resolve_runtime_port(lookup: &DeviceLookup, placement: &Placement) -> Option<String> {
    if let Some(device_id) = placement.device_id.as_deref().filter(|value| !value.is_empty()) {
        if let Some(port) = lookup.device_by_id(device_id).and_then(|device| string_value(device, "port")) {
            return Some(port);
        }
    }
    let fallback_port = placement.legacy_port.as_deref().filter(|value| !value.is_empty())?;
    lookup
        .device_by_port(fallback_port)
        .and_then(|device| string_value(device, "port"))
}

fn build_local_indices(matrix: Option<&Matrix>, count: usize) -> Vec<usize> {
    if let Some(matrix) = matrix {
        let mut seen = HashSet::new();
        let mut indices = matrix
            .map
            .iter()
            .filter_map(|mapped| usize::try_from(*mapped).ok())
            .filter(|index| *index < count)
            .filter(|index| seen.insert(*index))
            .collect::<Vec<_>>();
        indices.sort_unstable();
        return indices;
    }
    (0..count).collect()
}

fn sanitize_non_negative_int(value: Option<&Value>, fallback: usize) -> usize {
    let raw = value.and_then(number_from_value).unwrap_or(fallback as f64);
    if !raw.is_finite() {
        return fallback;
    }
    (raw + 0.5).floor().max(0.0) as usize
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
}

fn is_valid_layout_id(value: &str) -> bool {
    value.len() == LAYOUT_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn default_config_version() -> u32 {
    2
}

fn default_brightness() -> u8 {
    100
}
