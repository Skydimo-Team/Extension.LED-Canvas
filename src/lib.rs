mod abi;
mod host;
mod model;
mod routing;

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::abi::{
    ffi_str, SkydimoControllerApiV1, SkydimoEffectApiV1, SkydimoExtensionApiV1,
    SkydimoHostApiV1, SkydimoOutputFrameV1, SkydimoPluginApiV1, SkydimoRgb,
    SKYDIMO_NATIVE_C_ABI_VERSION, SKYDIMO_PLUGIN_KIND_EXTENSION,
};
use crate::host::Host;
use crate::model::{
    build_default_effect_params, build_preview_override, default_config, filter_devices_for_page,
    identity_matrix_map, layout_port, layout_summary, normalize_config, normalize_layout,
    normalize_placements, placement_lock_key, placement_routing_key,
    runtime_placement, sanitize_canvas_side, sanitize_layout_name, Config, DeviceLookup,
    IdGenerator, Layout, Matrix, Placement, PlacementStatus, VirtualDevice,
    CANVAS_MANUFACTURER, CANVAS_OUTPUT_ID, CANVAS_PORT_PREFIX, DEFAULT_GRID_H, DEFAULT_GRID_W,
};
use crate::routing::RoutingTable;

const META_FILE: &str = "meta.json";
const LEGACY_CONFIG_FILE: &str = "config.json";
const CONFIG_VERSION: u32 = 2;

#[derive(Clone)]
struct PreviewOverride {
    placements: Vec<Placement>,
    canvas: model::Canvas,
}

#[derive(Clone, Default)]
struct DesiredLock {
    port: String,
    output_id: String,
    indices: HashSet<usize>,
}

struct LedCanvasExtension {
    host: Host,
    config: Config,
    routing_tables: HashMap<String, RoutingTable>,
    core_locked_outputs: HashMap<String, DesiredLock>,
    placement_led_status: HashMap<String, HashMap<String, PlacementStatus>>,
    preview_overrides: HashMap<String, PreviewOverride>,
    rng: IdGenerator,
    data_dir: PathBuf,
}

impl LedCanvasExtension {
    unsafe fn new(host: *const SkydimoHostApiV1) -> Self {
        let mut rng = IdGenerator::new();
        Self {
            host: unsafe { Host::from_raw(host) },
            config: default_config(&mut rng),
            routing_tables: HashMap::new(),
            core_locked_outputs: HashMap::new(),
            placement_led_status: HashMap::new(),
            preview_overrides: HashMap::new(),
            rng,
            data_dir: PathBuf::new(),
        }
    }

    fn start(&mut self) -> Result<(), String> {
        self.host.log_info("LED Canvas native extension started");
        self.data_dir = self
            .host
            .call("data_dir", Value::Null)?
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        if let Err(err) = fs::create_dir_all(&self.data_dir) {
            self.host
                .log_warn(&format!("failed to create LED Canvas data dir: {err}"));
        }

        let devices = self.get_devices();
        let lookup = DeviceLookup::from_devices(&devices);
        let raw_config = self.load_config_value();
        self.config = normalize_config(raw_config, &lookup, &mut self.rng);

        let to_register = self
            .config
            .layouts
            .iter()
            .filter(|layout| layout.registered)
            .map(|layout| layout.id.clone())
            .collect::<Vec<_>>();
        for layout in &mut self.config.layouts {
            if layout.registered {
                layout.registered = false;
            }
        }
        for layout_id in to_register {
            let _ = self.do_register_canvas(&layout_id);
        }

        let (lookup, _) = self.sync_live_canvas_layout_state(None);
        self.rebuild_all_routing(Some(&lookup));
        self.save_config();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        let registered = self
            .config
            .layouts
            .iter()
            .filter(|layout| layout.registered)
            .map(|layout| layout.id.clone())
            .collect::<Vec<_>>();
        for layout_id in registered {
            self.do_unregister_canvas(&layout_id);
            if let Some(layout) = self.find_layout_mut(&layout_id) {
                layout.registered = true;
            }
        }
        self.sync_core_locks(HashMap::new());
        self.save_config();
        self.host.log_info("LED Canvas native extension stopped");
        Ok(())
    }

    fn on_event_json(&mut self, event: &str, data: Value) {
        if event == "devices-changed" {
            self.on_devices_changed(data);
        }
    }

    fn on_devices_changed(&mut self, devices: Value) {
        let lookup = DeviceLookup::from_devices(&devices);
        let config_value = serde_json::to_value(&self.config).unwrap_or(Value::Null);
        self.config = normalize_config(config_value, &lookup, &mut self.rng);
        self.sync_canvas_nicknames(&devices);
        self.sync_canvas_virtual_device_states();
        self.rebuild_all_routing(Some(&lookup));
        self.save_config();
        self.page_emit(json!({ "type": "devices", "data": filter_devices_for_page(&devices) }));
        self.emit_full_state(Some(&lookup));
    }

    fn on_page_message(&mut self, msg: Value) {
        let Some(message_type) = msg.get("type").and_then(Value::as_str) else {
            return;
        };

        match message_type {
            "get_devices" => {
                let devices = self.get_devices();
                self.page_emit(json!({ "type": "devices", "data": filter_devices_for_page(&devices) }));
            }
            "get_effects_catalog" => self.emit_effect_catalog(),
            "get_full_state" | "get_canvas_status" => {
                let (lookup, changed) = self.sync_live_canvas_layout_state(None);
                if changed {
                    self.save_config();
                }
                self.emit_full_state(Some(&lookup));
            }
            "switch_layout" => {
                if let Some(layout_id) = msg.get("layout_id").and_then(Value::as_str) {
                    if self.find_layout(layout_id).is_some() {
                        self.config.active_layout_id = layout_id.to_string();
                        self.save_config();
                        self.emit_full_state(None);
                    }
                }
            }
            "create_layout" => self.create_layout(msg.get("name").and_then(Value::as_str)),
            "delete_layout" => self.delete_layout(msg.get("layout_id").and_then(Value::as_str)),
            "rename_layout" => self.rename_layout(
                msg.get("layout_id").and_then(Value::as_str),
                msg.get("name").and_then(Value::as_str),
            ),
            "register_canvas" => {
                let layout_id = msg
                    .get("layout_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| self.config.active_layout_id.clone());
                if msg.get("width").is_some() || msg.get("height").is_some() {
                    self.sync_canvas_size(
                        &layout_id,
                        msg.get("width").cloned(),
                        msg.get("height").cloned(),
                    );
                }
                if self.find_layout(&layout_id).is_some_and(|layout| !layout.registered) {
                    self.register_canvas_device(&layout_id);
                }
                self.save_config();
                self.emit_full_state(None);
            }
            "unregister_canvas" => {
                let layout_id = self.message_layout_id(&msg);
                self.preview_overrides.remove(&layout_id);
                self.unregister_canvas_device(&layout_id);
                self.save_config();
                self.emit_full_state(None);
            }
            "preview_placements" => self.preview_placements(msg),
            "clear_placement_preview" => {
                let layout_id = self.message_layout_id(&msg);
                if self.preview_overrides.remove(&layout_id).is_some() {
                    self.rebuild_all_routing(None);
                }
            }
            "update_placements" => self.update_placements(msg),
            "update_placement_brightness" => self.update_placement_brightness(msg),
            "update_snap" => self.update_snap(msg),
            "set_layout_virtual_power" => self.set_virtual_power(msg),
            "set_layout_virtual_paused" => self.set_virtual_paused(msg),
            "set_layout_virtual_effect" => self.set_virtual_effect(msg),
            "update_layout_virtual_effect_params" => self.update_virtual_effect_params(msg),
            "reset_layout_virtual_effect_params" => self.reset_virtual_effect_params(msg),
            "scan_studio_tabs" => self.scan_studio_tabs(),
            "import_studio_tab" => self.import_studio_tab(msg),
            _ => {}
        }
    }

    fn on_device_frame(&mut self, port: String, frames: &[SkydimoOutputFrameV1]) {
        let prefix = format!("{CANVAS_PORT_PREFIX}:");
        let Some(layout_id) = port.strip_prefix(&prefix) else {
            return;
        };
        let Some(layout) = self.find_layout(layout_id) else {
            return;
        };
        if !layout.registered {
            return;
        }
        let Some(table) = self.routing_tables.get(layout_id) else {
            return;
        };
        let Some(canvas_frame) = find_canvas_frame(frames) else {
            return;
        };

        let routed = routing::route(canvas_frame, table);
        for output in &routed {
            if let Err(err) =
                self.host
                    .set_leds_rgb(&output.port, &output.output_id, &output.colors)
            {
                self.host.log_warn(&format!(
                    "set_leds failed for {}::{}: {err}",
                    output.port, output.output_id
                ));
            }
        }

        let placements = routed
            .iter()
            .map(|output| {
                json!({
                    "placement_id": output.placement_id,
                    "colors_rgb": output.preview_rgb,
                })
            })
            .collect::<Vec<_>>();
        self.page_emit(json!({
            "type": "preview_frame",
            "layout_id": layout_id,
            "canvas_rgb": routing::rgb_vec_base64(canvas_frame),
            "placements": placements,
        }));
    }

    fn create_layout(&mut self, name: Option<&str>) {
        let mut ids = self
            .config
            .layouts
            .iter()
            .map(|layout| layout.id.clone())
            .collect::<HashSet<_>>();
        let id = self.rng.next_layout_id(&mut ids);
        let layout = Layout {
            id: id.clone(),
            name: sanitize_layout_name(name, Some(&format!("Layout {}", self.config.layouts.len() + 1))),
            registered: false,
            canvas: model::Canvas {
                width: DEFAULT_GRID_W,
                height: DEFAULT_GRID_H,
                x: 0.0,
                y: 0.0,
            },
            placements: Vec::new(),
            snap_to_grid: false,
            virtual_device: VirtualDevice::default(),
        };
        self.config.layouts.push(layout);
        self.config.active_layout_id = id;
        self.save_config();
        self.emit_full_state(None);
    }

    fn delete_layout(&mut self, layout_id: Option<&str>) {
        let Some(layout_id) = layout_id else {
            return;
        };
        if self.config.layouts.len() <= 1 {
            return;
        }
        let Some(index) = self.find_layout_index(layout_id) else {
            return;
        };
        self.preview_overrides.remove(layout_id);
        if self.config.layouts[index].registered {
            self.unregister_canvas_device(layout_id);
        }
        if let Some(index) = self.find_layout_index(layout_id) {
            self.config.layouts.remove(index);
        }
        if self.config.active_layout_id == layout_id {
            if let Some(first) = self.config.layouts.first() {
                self.config.active_layout_id = first.id.clone();
            }
        }
        self.save_config();
        self.emit_full_state(None);
    }

    fn rename_layout(&mut self, layout_id: Option<&str>, name: Option<&str>) {
        let (Some(layout_id), Some(name)) = (layout_id, name) else {
            return;
        };
        let Some(index) = self.find_layout_index(layout_id) else {
            return;
        };
        let previous = self.config.layouts[index].name.clone();
        let next = sanitize_layout_name(Some(name), Some(&previous));
        if next == previous {
            return;
        }
        let registered = self.config.layouts[index].registered;
        self.config.layouts[index].name = next.clone();
        if registered {
            if let Err(err) = self.host.call(
                "set_device_nickname",
                json!({ "port": layout_port(layout_id), "nickname": next }),
            ) {
                self.config.layouts[index].name = previous;
                self.host.log_warn(&format!("set_device_nickname failed: {err}"));
                self.emit_layout_status(layout_id, None);
                return;
            }
        }
        self.save_config();
        self.emit_layout_status(layout_id, None);
    }

    fn preview_placements(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let Some(layout) = self.find_layout(&layout_id).cloned() else {
            return;
        };
        let devices = self.get_devices();
        let lookup = DeviceLookup::from_devices(&devices);
        let (placements, canvas) = build_preview_override(
            &layout,
            msg.get("data").unwrap_or(&Value::Null),
            msg.get("canvas"),
            &lookup,
            &mut self.rng,
        );
        self.preview_overrides
            .insert(layout_id, PreviewOverride { placements, canvas });
        self.rebuild_all_routing(Some(&lookup));
    }

    fn update_placements(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let devices = self.get_devices();
        let lookup = DeviceLookup::from_devices(&devices);
        let placements = normalize_placements(msg.get("data").unwrap_or(&Value::Null), &lookup, &mut self.rng);
        let mut should_rebuild = true;
        if let Some(layout) = self.find_layout_mut(&layout_id) {
            layout.placements = placements;
        } else {
            return;
        }
        self.preview_overrides.remove(&layout_id);
        if let Some(canvas) = msg.get("canvas") {
            should_rebuild = !self.sync_canvas_size(
                &layout_id,
                canvas.get("width").cloned(),
                canvas.get("height").cloned(),
            );
        }
        if should_rebuild {
            self.rebuild_all_routing(Some(&lookup));
        }
        self.save_config();
        self.emit_full_state(Some(&lookup));
    }

    fn update_placement_brightness(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let Some(placement_id) = msg.get("placement_id").and_then(Value::as_str) else {
            return;
        };
        let brightness = model::sanitize_brightness(msg.get("brightness"));
        let Some(layout) = self.find_layout_mut(&layout_id) else {
            return;
        };
        if let Some(placement) = layout.placements.iter_mut().find(|placement| placement.id == placement_id) {
            placement.brightness = brightness;
        }
        self.rebuild_all_routing(None);
        self.save_config();
    }

    fn update_snap(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let Some(layout) = self.find_layout_mut(&layout_id) else {
            return;
        };
        layout.snap_to_grid = msg
            .get("snap_to_grid")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.save_config();
        self.emit_layout_status(&layout_id, None);
    }

    fn set_virtual_power(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let Some(power_on) = msg.get("power_on").and_then(Value::as_bool) else {
            return;
        };
        self.with_virtual_rollback(&layout_id, |this, layout| {
            layout.virtual_device.power_on = power_on;
            if layout.registered {
                this.host.call(
                    "set_scope_power",
                    json!({
                        "port": layout_port(&layout.id),
                        "output_id": CANVAS_OUTPUT_ID,
                        "is_off": !layout.virtual_device.power_on,
                    }),
                )?;
            }
            Ok(())
        });
    }

    fn set_virtual_paused(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let paused = msg.get("paused").and_then(Value::as_bool).unwrap_or(false);
        self.with_virtual_rollback(&layout_id, |this, layout| {
            layout.virtual_device.paused = paused;
            if layout.registered {
                this.host.call(
                    "set_scope_mode_paused",
                    json!({
                        "port": layout_port(&layout.id),
                        "output_id": CANVAS_OUTPUT_ID,
                        "paused": layout.virtual_device.paused,
                    }),
                )?;
            }
            Ok(())
        });
    }

    fn set_virtual_effect(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let effect_id = msg
            .get("effect_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let defaults = effect_id
            .as_ref()
            .map(|id| self.default_effect_params(id))
            .unwrap_or_default();
        self.with_virtual_rollback(&layout_id, move |this, layout| {
            layout.virtual_device.effect_id = effect_id.clone();
            layout.virtual_device.effect_params = defaults.clone();
            if layout.registered {
                let params = if layout.virtual_device.effect_params.is_empty() {
                    Value::Null
                } else {
                    Value::Object(layout.virtual_device.effect_params.clone())
                };
                this.host.call(
                    "set_scope_effect",
                    json!({
                        "port": layout_port(&layout.id),
                        "output_id": CANVAS_OUTPUT_ID,
                        "effect_id": layout.virtual_device.effect_id,
                        "params": params,
                    }),
                )?;
            }
            Ok(())
        });
    }

    fn update_virtual_effect_params(&mut self, msg: Value) {
        let requested_layout_id = self.message_layout_id(&msg);
        let params = msg
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let sync_seq = msg.get("sync_seq").cloned();

        if self.find_layout(&requested_layout_id).is_none() {
            self.emit_effect_params_sync_ack(&requested_layout_id, sync_seq);
            return;
        }

        self.with_virtual_rollback(&requested_layout_id, move |this, layout| {
            if layout.virtual_device.effect_id.is_none() {
                layout.virtual_device.effect_params = Map::new();
                return Ok(());
            }
            layout.virtual_device.effect_params = params.clone();
            if layout.registered {
                this.host.call(
                    "update_scope_effect_params",
                    json!({
                        "port": layout_port(&layout.id),
                        "output_id": CANVAS_OUTPUT_ID,
                        "params": layout.virtual_device.effect_params,
                    }),
                )?;
            }
            Ok(())
        });
        self.emit_effect_params_sync_ack(&requested_layout_id, sync_seq);
    }

    fn reset_virtual_effect_params(&mut self, msg: Value) {
        let layout_id = self.message_layout_id(&msg);
        let defaults = self
            .find_layout(&layout_id)
            .and_then(|layout| layout.virtual_device.effect_id.clone())
            .map(|effect_id| self.default_effect_params(&effect_id))
            .unwrap_or_default();

        self.with_virtual_rollback(&layout_id, move |this, layout| {
            if layout.virtual_device.effect_id.is_none() {
                layout.virtual_device.effect_params = Map::new();
                return Ok(());
            }
            layout.virtual_device.effect_params = defaults.clone();
            if layout.registered {
                this.host.call(
                    "reset_scope_effect_params",
                    json!({
                        "port": layout_port(&layout.id),
                        "output_id": CANVAS_OUTPUT_ID,
                    }),
                )?;
            }
            Ok(())
        });
    }

    fn with_virtual_rollback(
        &mut self,
        layout_id: &str,
        action: impl FnOnce(&mut Self, &mut Layout) -> Result<(), String>,
    ) {
        let Some(index) = self.find_layout_index(layout_id) else {
            return;
        };
        let previous = self.config.layouts[index].virtual_device.clone();
        let mut layout = self.config.layouts.remove(index);
        let result = action(self, &mut layout);
        let insert_at = index.min(self.config.layouts.len());
        self.config.layouts.insert(insert_at, layout);

        if let Err(err) = result {
            if let Some(layout) = self.find_layout_mut(layout_id) {
                layout.virtual_device = previous;
            }
            self.host
                .log_warn(&format!("virtual-device op failed for layout {layout_id}: {err}"));
            self.emit_layout_status(layout_id, None);
            return;
        }

        self.save_config();
        self.emit_layout_status(layout_id, None);
    }

    fn register_canvas_device(&mut self, layout_id: &str) {
        if self.do_register_canvas(layout_id) {
            self.rebuild_all_routing(None);
        }
    }

    fn do_register_canvas(&mut self, layout_id: &str) -> bool {
        let Some(layout) = self.find_layout(layout_id).cloned() else {
            return false;
        };
        let name = sanitize_layout_name(Some(&layout.name), Some(&layout.id));
        let cw = layout.canvas.width.max(1);
        let ch = layout.canvas.height.max(1);
        let total_leds = cw.saturating_mul(ch);
        let port = layout_port(&layout.id);

        let result = self.host.call(
            "register_device",
            json!({
                "controller_port": port,
                "device_path": port,
                "controller_id": "extension.led_canvas.canvas",
                "nickname": name,
                "manufacturer": CANVAS_MANUFACTURER,
                "model": "Virtual Canvas",
                "description": format!("Virtual Canvas {cw}x{ch}"),
                "serial_id": layout.id,
                "device_type": "virtual",
                "outputs": [{
                    "id": CANVAS_OUTPUT_ID,
                    "name": "Canvas",
                    "output_type": "matrix",
                    "leds_count": total_leds,
                    "matrix": {
                        "width": cw,
                        "height": ch,
                        "map": identity_matrix_map(cw, ch),
                    },
                }],
            }),
        );

        match result {
            Ok(_) => {
                if let Some(layout) = self.find_layout_mut(layout_id) {
                    layout.name = name.clone();
                    layout.registered = true;
                }
                self.move_layout_after_registered(layout_id);
                if let Err(err) = self.apply_layout_virtual_state(layout_id) {
                    self.host.log_warn(&format!(
                        "failed to apply virtual-device state for layout {layout_id}: {err}"
                    ));
                }
                self.host
                    .log_info(&format!("Canvas registered: {name} ({port}, {cw}x{ch})"));
                true
            }
            Err(err) => {
                self.host.log_error(&format!(
                    "failed to register canvas for layout {layout_id}: {err}"
                ));
                false
            }
        }
    }

    fn unregister_canvas_device(&mut self, layout_id: &str) {
        self.do_unregister_canvas(layout_id);
        self.rebuild_all_routing(None);
    }

    fn do_unregister_canvas(&mut self, layout_id: &str) {
        if !self
            .find_layout(layout_id)
            .is_some_and(|layout| layout.registered)
        {
            return;
        }
        let port = layout_port(layout_id);
        let _ = self
            .host
            .call("remove_extension_device", json!({ "port": port }));
        if let Some(layout) = self.find_layout_mut(layout_id) {
            layout.registered = false;
        }
        self.routing_tables.remove(layout_id);
        self.host
            .log_info(&format!("Canvas unregistered: {layout_id}"));
    }

    fn sync_canvas_size(&mut self, layout_id: &str, width: Option<Value>, height: Option<Value>) -> bool {
        let Some(index) = self.find_layout_index(layout_id) else {
            return false;
        };
        let current = self.config.layouts[index].canvas.clone();
        let cw = sanitize_canvas_side(width.as_ref(), current.width);
        let ch = sanitize_canvas_side(height.as_ref(), current.height);
        let changed = cw != current.width || ch != current.height;
        self.config.layouts[index].canvas.width = cw;
        self.config.layouts[index].canvas.height = ch;

        if changed && self.config.layouts[index].registered {
            let total_leds = cw.saturating_mul(ch);
            let port = layout_port(layout_id);
            match self.host.call(
                "update_output",
                json!({
                    "port": port,
                    "output_id": CANVAS_OUTPUT_ID,
                    "leds_count": total_leds,
                    "matrix": {
                        "width": cw,
                        "height": ch,
                        "map": identity_matrix_map(cw, ch),
                    },
                }),
            ) {
                Ok(_) => {
                    self.host.log_info(&format!("Canvas resized: {layout_id} ({cw}x{ch})"));
                    self.rebuild_all_routing(None);
                    return true;
                }
                Err(err) => self.host.log_error(&format!("failed to resize canvas: {err}")),
            }
        }

        false
    }

    fn rebuild_all_routing(&mut self, lookup: Option<&DeviceLookup>) {
        let owned_lookup;
        let lookup = if let Some(lookup) = lookup {
            lookup
        } else {
            owned_lookup = DeviceLookup::from_devices(&self.get_devices());
            &owned_lookup
        };
        let mut desired_locks: HashMap<String, DesiredLock> = HashMap::new();
        let mut occupied_by_output: HashMap<String, HashMap<usize, String>> = HashMap::new();
        let mut next_routing_tables = HashMap::new();
        let mut next_status = HashMap::new();

        for layout in &self.config.layouts {
            let mut status = HashMap::new();
            let preview = self.preview_overrides.get(&layout.id);
            let placement_source = preview
                .map(|preview| preview.placements.as_slice())
                .unwrap_or(layout.placements.as_slice());
            let canvas_source = preview
                .map(|preview| &preview.canvas)
                .unwrap_or(&layout.canvas);

            if layout.registered {
                let runtime_placements = placement_source
                    .iter()
                    .filter_map(|placement| runtime_placement(placement, lookup))
                    .filter(|placement| !placement.actual_indices.is_empty())
                    .collect::<Vec<_>>();
                let mut table = routing::build(
                    &runtime_placements,
                    canvas_source.width,
                    canvas_source.height,
                );

                for runtime in &runtime_placements {
                    let output_key = placement_lock_key(runtime);
                    let routing_key = placement_routing_key(runtime);
                    let Some(entry) = table.entries.get_mut(&routing_key) else {
                        continue;
                    };
                    let occupied = occupied_by_output.entry(output_key.clone()).or_default();
                    let desired = desired_locks
                        .entry(output_key)
                        .or_insert_with(|| DesiredLock {
                            port: runtime.port.clone(),
                            output_id: runtime.output_id.clone(),
                            indices: HashSet::new(),
                        });
                    let mut available_leds = Vec::with_capacity(entry.leds.len());
                    let mut blocked = Vec::new();

                    for led in entry.leds.drain(..) {
                        match occupied.get(&led.target_idx) {
                            None => {
                                occupied.insert(led.target_idx, layout.id.clone());
                                desired.indices.insert(led.target_idx);
                                available_leds.push(led);
                            }
                            Some(owner) if owner == &layout.id => {
                                desired.indices.insert(led.target_idx);
                                available_leds.push(led);
                            }
                            Some(_) => blocked.push(led.local_idx),
                        }
                    }

                    let available_count = available_leds.len();
                    entry.leds = available_leds;
                    status.insert(runtime.id.clone(), PlacementStatus {
                        blocked_led_count: blocked.len(),
                        blocked_led_indices: blocked,
                        available_led_count: available_count,
                    });
                }

                next_routing_tables.insert(layout.id.clone(), table);
            } else {
                for placement in placement_source {
                    let Some(runtime) = runtime_placement(placement, lookup) else {
                        continue;
                    };
                    let occupied = occupied_by_output
                        .get(&placement_lock_key(&runtime))
                        .cloned()
                        .unwrap_or_default();
                    let mut blocked = Vec::new();
                    let mut available_count = 0usize;
                    for (index, local_idx) in runtime.local_indices.iter().enumerate() {
                        let Some(actual_idx) = runtime.actual_indices.get(index).copied() else {
                            continue;
                        };
                        match occupied.get(&actual_idx) {
                            Some(owner) if owner != &layout.id => blocked.push(*local_idx),
                            _ => available_count += 1,
                        }
                    }
                    status.insert(runtime.id.clone(), PlacementStatus {
                        blocked_led_count: blocked.len(),
                        blocked_led_indices: blocked,
                        available_led_count: available_count,
                    });
                }
            }

            next_status.insert(layout.id.clone(), status);
        }

        self.routing_tables = next_routing_tables;
        self.placement_led_status = next_status;
        self.sync_core_locks(desired_locks);
    }

    fn sync_core_locks(&mut self, desired_outputs: HashMap<String, DesiredLock>) {
        let mut next_state = HashMap::new();

        for (key, desired) in &desired_outputs {
            if let Some(existing) = self.core_locked_outputs.get(key) {
                let to_unlock = existing
                    .indices
                    .difference(&desired.indices)
                    .copied()
                    .collect::<Vec<_>>();
                if !to_unlock.is_empty() {
                    self.unlock_leds(&existing.port, &existing.output_id, &to_unlock, key);
                }

                let to_lock = desired
                    .indices
                    .difference(&existing.indices)
                    .copied()
                    .collect::<Vec<_>>();
                if !to_lock.is_empty() {
                    self.lock_leds(&desired.port, &desired.output_id, &to_lock, key);
                }
            } else {
                let mut indices = desired.indices.iter().copied().collect::<Vec<_>>();
                indices.sort_unstable();
                if !indices.is_empty() {
                    self.lock_leds(&desired.port, &desired.output_id, &indices, key);
                }
            }

            next_state.insert(key.clone(), desired.clone());
        }

        let stale = self
            .core_locked_outputs
            .iter()
            .filter(|(key, _)| !desired_outputs.contains_key(*key))
            .map(|(key, existing)| (key.clone(), existing.clone()))
            .collect::<Vec<_>>();
        for (key, existing) in stale {
            let mut indices = existing.indices.iter().copied().collect::<Vec<_>>();
            indices.sort_unstable();
            if !indices.is_empty() {
                self.unlock_leds(&existing.port, &existing.output_id, &indices, &key);
            }
        }

        self.core_locked_outputs = next_state;
    }

    fn lock_leds(&self, port: &str, output_id: &str, indices: &[usize], key: &str) {
        if let Err(err) = self.host.lock_leds(port, output_id, indices) {
            self.host
                .log_warn(&format!("failed to lock {key}: {err}"));
        }
    }

    fn unlock_leds(&self, port: &str, output_id: &str, indices: &[usize], key: &str) {
        if let Err(err) = self.host.unlock_leds(port, output_id, indices) {
            self.host
                .log_warn(&format!("failed to unlock {key}: {err}"));
        }
    }

    fn apply_layout_virtual_state(&self, layout_id: &str) -> Result<(), String> {
        let Some(layout) = self.find_layout(layout_id) else {
            return Ok(());
        };
        if !layout.registered {
            return Ok(());
        }
        let params = if layout.virtual_device.effect_params.is_empty() {
            Value::Null
        } else {
            Value::Object(layout.virtual_device.effect_params.clone())
        };
        self.host.call(
            "set_scope_effect",
            json!({
                "port": layout_port(&layout.id),
                "output_id": CANVAS_OUTPUT_ID,
                "effect_id": layout.virtual_device.effect_id,
                "params": params,
            }),
        )?;
        self.host.call(
            "set_scope_power",
            json!({
                "port": layout_port(&layout.id),
                "output_id": CANVAS_OUTPUT_ID,
                "is_off": !layout.virtual_device.power_on,
            }),
        )?;
        if layout.virtual_device.paused {
            self.host.call(
                "set_scope_mode_paused",
                json!({
                    "port": layout_port(&layout.id),
                    "output_id": CANVAS_OUTPUT_ID,
                    "paused": true,
                }),
            )?;
        }
        Ok(())
    }

    fn sync_live_canvas_layout_state(&mut self, devices: Option<Value>) -> (DeviceLookup, bool) {
        let current_devices = devices.unwrap_or_else(|| self.get_devices());
        let names_changed = self.sync_canvas_nicknames(&current_devices);
        let virtual_state_changed = self.sync_canvas_virtual_device_states();
        (DeviceLookup::from_devices(&current_devices), names_changed || virtual_state_changed)
    }

    fn sync_canvas_nicknames(&mut self, devices: &Value) -> bool {
        let Some(devices) = devices.as_array() else {
            return false;
        };
        let mut changed = false;
        for layout in &mut self.config.layouts {
            if !layout.registered {
                continue;
            }
            let port = layout_port(&layout.id);
            let Some(device) = devices
                .iter()
                .find(|device| device.get("port").and_then(Value::as_str) == Some(port.as_str()))
            else {
                continue;
            };
            let name = sanitize_layout_name(device.get("nickname").and_then(Value::as_str), Some(&layout.id));
            if name != layout.name {
                layout.name = name;
                changed = true;
            }
        }
        changed
    }

    fn sync_canvas_virtual_device_states(&mut self) -> bool {
        let mut changed = false;
        let ids = self
            .config
            .layouts
            .iter()
            .filter(|layout| layout.registered)
            .map(|layout| layout.id.clone())
            .collect::<Vec<_>>();
        for layout_id in ids {
            let Some(live) = self.read_live_virtual_state(&layout_id) else {
                continue;
            };
            let Some(layout) = self.find_layout_mut(&layout_id) else {
                continue;
            };
            if serde_json::to_value(&layout.virtual_device).ok()
                != serde_json::to_value(&live).ok()
            {
                layout.virtual_device = live;
                changed = true;
            }
        }
        changed
    }

    fn read_live_virtual_state(&self, layout_id: &str) -> Option<VirtualDevice> {
        let device = self
            .host
            .call("get_device_info", json!({ "port": layout_port(layout_id) }))
            .ok()?;
        let output = device
            .get("outputs")
            .and_then(Value::as_array)
            .and_then(|outputs| {
                outputs
                    .iter()
                    .find(|output| output.get("id").and_then(Value::as_str) == Some(CANVAS_OUTPUT_ID))
            });
        let mode = output
            .and_then(|output| output.get("mode"))
            .or_else(|| device.get("mode"));
        let power = output
            .and_then(|output| output.get("power"))
            .or_else(|| device.get("power"));
        let effect_id = mode
            .and_then(|mode| mode.get("effective_effect_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let effect_params = if effect_id.is_some() {
            mode.and_then(|mode| mode.get("effective_params"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        } else {
            Map::new()
        };
        let power_on = power
            .and_then(|power| power.get("effective_is_off"))
            .and_then(Value::as_bool)
            .map(|is_off| !is_off)
            .unwrap_or(true);
        let paused = mode
            .and_then(|mode| mode.get("effective_is_paused"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Some(VirtualDevice {
            power_on,
            paused,
            effect_id,
            effect_params,
        })
    }

    fn emit_effect_catalog(&self) {
        let effects = self.host.call("get_effects", Value::Null).unwrap_or(Value::Array(Vec::new()));
        let catalog = effects
            .as_array()
            .map(|effects| {
                effects
                    .iter()
                    .filter_map(|effect| {
                        let id = effect.get("id").and_then(Value::as_str)?;
                        let params = self
                            .host
                            .call("get_effect_params", json!({ "effect_id": id }))
                            .unwrap_or(Value::Array(Vec::new()));
                        Some(json!({
                            "id": id,
                            "name": effect.get("name").cloned(),
                            "description": effect.get("description").cloned(),
                            "group": effect.get("group").cloned(),
                            "icon": effect.get("icon").cloned(),
                            "params": params,
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.page_emit(json!({ "type": "effects_catalog", "effects": catalog }));
    }

    fn default_effect_params(&self, effect_id: &str) -> Map<String, Value> {
        let params = self
            .host
            .call("get_effect_params", json!({ "effect_id": effect_id }))
            .unwrap_or(Value::Array(Vec::new()));
        build_default_effect_params(&params)
    }

    fn emit_full_state(&self, lookup: Option<&DeviceLookup>) {
        let owned_lookup;
        let lookup = if let Some(lookup) = lookup {
            lookup
        } else {
            owned_lookup = DeviceLookup::from_devices(&self.get_devices());
            &owned_lookup
        };
        let layouts = self
            .config
            .layouts
            .iter()
            .map(|layout| {
                layout_summary(
                    layout,
                    lookup,
                    self.placement_led_status.get(&layout.id),
                )
            })
            .collect::<Vec<_>>();
        self.page_emit(json!({
            "type": "full_state",
            "active_layout_id": self.config.active_layout_id,
            "layouts": layouts,
        }));
    }

    fn emit_layout_status(&self, layout_id: &str, lookup: Option<&DeviceLookup>) {
        let Some(layout) = self.find_layout(layout_id) else {
            return;
        };
        let owned_lookup;
        let lookup = if let Some(lookup) = lookup {
            lookup
        } else {
            owned_lookup = DeviceLookup::from_devices(&self.get_devices());
            &owned_lookup
        };
        self.page_emit(json!({
            "type": "layout_status",
            "layout": layout_summary(
                layout,
                lookup,
                self.placement_led_status.get(&layout.id),
            ),
        }));
    }

    fn emit_effect_params_sync_ack(&self, layout_id: &str, sync_seq: Option<Value>) {
        if let Some(sync_seq) = sync_seq {
            self.page_emit(json!({
                "type": "effect_params_sync_ack",
                "layout_id": layout_id,
                "sync_seq": sync_seq,
            }));
        }
    }

    fn page_emit(&self, payload: Value) {
        if let Err(err) = self.host.call("page_emit", payload) {
            self.host
                .log_warn(&format!("page_emit failed for LED Canvas: {err}"));
        }
    }

    fn get_devices(&self) -> Value {
        self.host
            .call("get_devices", Value::Null)
            .unwrap_or_else(|err| {
                self.host
                    .log_warn(&format!("failed to query devices: {err}"));
                Value::Array(Vec::new())
            })
    }

    fn save_config(&mut self) {
        let lookup = DeviceLookup::from_devices(&self.get_devices());
        let config_value = serde_json::to_value(&self.config).unwrap_or(Value::Null);
        self.config = normalize_config(config_value, &lookup, &mut self.rng);
        if let Err(err) = self.write_config_value() {
            self.host
                .log_error(&format!("store: failed to save config: {err}"));
        }
    }

    fn load_config_value(&self) -> Value {
        let meta_path = self.data_path(META_FILE);
        let legacy_path = self.data_path(LEGACY_CONFIG_FILE);
        let meta = read_json_file(&meta_path);
        if meta.as_ref().is_err() {
            match read_json_file(&legacy_path) {
                Ok(mut legacy) => {
                    if legacy.get("version").is_none() {
                        legacy["version"] = Value::from(1);
                    }
                    self.host
                        .log_info("store: loaded legacy layout config from config.json");
                    return legacy;
                }
                Err(legacy_err) => {
                    self.host.log_info(&format!(
                        "store: no persisted layout meta, using defaults (legacy={legacy_err})"
                    ));
                    return Value::Null;
                }
            }
        }

        let meta = meta.unwrap_or(Value::Null);
        let ids = meta
            .get("layout_ids")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut layouts = Vec::new();
        for id in ids {
            let Some(layout_id) = id.as_str() else {
                continue;
            };
            match read_json_file(&self.data_path(&format!("{layout_id}.json"))) {
                Ok(layout) => layouts.push(layout),
                Err(err) => self
                    .host
                    .log_warn(&format!("store: failed to load layout {layout_id}: {err}")),
            }
        }
        if layouts.is_empty() {
            return Value::Null;
        }
        json!({
            "version": meta.get("version").and_then(Value::as_u64).unwrap_or(CONFIG_VERSION as u64),
            "active_layout_id": meta
                .get("active_layout_id")
                .and_then(Value::as_str)
                .unwrap_or_else(|| layouts[0].get("id").and_then(Value::as_str).unwrap_or("")),
            "layouts": layouts,
        })
    }

    fn write_config_value(&self) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|err| err.to_string())?;
        let previous_meta = read_json_file(&self.data_path(META_FILE)).ok();
        let mut stale_ids = previous_meta
            .as_ref()
            .and_then(|meta| meta.get("layout_ids"))
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();

        let mut next_ids = Vec::new();
        for layout in &self.config.layouts {
            write_json_file(
                &self.data_path(&format!("{}.json", layout.id)),
                serde_json::to_value(layout).map_err(|err| err.to_string())?,
            )?;
            next_ids.push(layout.id.clone());
            stale_ids.remove(&layout.id);
        }

        for layout_id in stale_ids {
            let _ = fs::remove_file(self.data_path(&format!("{layout_id}.json")));
        }

        write_json_file(
            &self.data_path(META_FILE),
            json!({
                "version": CONFIG_VERSION,
                "active_layout_id": self.config.active_layout_id,
                "layout_ids": next_ids,
            }),
        )?;
        let _ = fs::remove_file(self.data_path(LEGACY_CONFIG_FILE));
        Ok(())
    }

    fn data_path(&self, file_name: &str) -> PathBuf {
        self.data_dir.join(file_name)
    }

    fn move_layout_after_registered(&mut self, layout_id: &str) {
        let Some(index) = self.find_layout_index(layout_id) else {
            return;
        };
        let layout = self.config.layouts.remove(index);
        let insert_pos = self
            .config
            .layouts
            .iter()
            .rposition(|candidate| candidate.registered)
            .map(|index| index + 1)
            .unwrap_or(0);
        self.config.layouts.insert(insert_pos, layout);
    }

    fn message_layout_id(&self, msg: &Value) -> String {
        msg.get("layout_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.config.active_layout_id.clone())
    }

    fn find_layout_index(&self, layout_id: &str) -> Option<usize> {
        self.config
            .layouts
            .iter()
            .position(|layout| layout.id == layout_id)
    }

    fn find_layout(&self, layout_id: &str) -> Option<&Layout> {
        self.config.layouts.iter().find(|layout| layout.id == layout_id)
    }

    fn find_layout_mut(&mut self, layout_id: &str) -> Option<&mut Layout> {
        self.config
            .layouts
            .iter_mut()
            .find(|layout| layout.id == layout_id)
    }

    fn scan_studio_tabs(&self) {
        let Some(studio_dir) = studio_dir() else {
            self.page_emit(json!({ "type": "studio_scan_result", "tabs": [], "error": "no_appdata" }));
            return;
        };
        let raw_tabs = scan_studio_directory(&studio_dir, self.host);
        if raw_tabs.is_empty() {
            let error = if studio_dir.is_dir() {
                "no_tabs"
            } else {
                "no_studio_dir"
            };
            self.page_emit(json!({
                "type": "studio_scan_result",
                "tabs": [],
                "error": error,
                "path": studio_dir.to_string_lossy(),
            }));
            return;
        }

        let devices = self.get_devices();
        let filtered = filter_devices_for_page(&devices);
        let tabs = raw_tabs
            .iter()
            .map(|tab| {
                let zones_count = tab
                    .get("zones_data")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                json!({
                    "tab_serial": tab
                        .get("tab_serial")
                        .or_else(|| tab.get("_filename"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    "name": tab
                        .get("name")
                        .or_else(|| tab.get("tab_serial"))
                        .or_else(|| tab.get("_filename"))
                        .and_then(Value::as_str)
                        .unwrap_or("Studio"),
                    "zones_count": zones_count,
                    "device_matches": match_studio_to_devices(tab, &filtered),
                    "has_overrides": tab
                        .get("overrides")
                        .and_then(Value::as_object)
                        .is_some_and(|overrides| !overrides.is_empty()),
                })
            })
            .collect::<Vec<_>>();

        self.page_emit(json!({
            "type": "studio_scan_result",
            "tabs": tabs,
            "devices": filtered,
            "path": studio_dir.to_string_lossy(),
        }));
    }

    fn import_studio_tab(&mut self, msg: Value) {
        let Some(studio_dir) = studio_dir() else {
            self.page_emit(json!({ "type": "studio_import_result", "success": false, "error": "no_appdata" }));
            return;
        };
        let Some(tab_serial) = msg.get("tab_serial").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
            self.page_emit(json!({ "type": "studio_import_result", "success": false, "error": "no_tab_serial" }));
            return;
        };
        let tab_path = studio_dir.join(format!("{tab_serial}.json"));
        let tab = match read_json_file(&tab_path) {
            Ok(tab) => tab,
            Err(err) => {
                self.page_emit(json!({
                    "type": "studio_import_result",
                    "success": false,
                    "error": "file_not_found",
                    "detail": err,
                }));
                return;
            }
        };

        let resolved = msg
            .get("resolved_matches")
            .and_then(Value::as_array)
            .map(|matches| {
                matches
                    .iter()
                    .filter_map(|entry| {
                        let key = entry.get("member_key")?.as_str()?.to_string();
                        Some((key, entry.clone()))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let devices = self.get_devices();
        let lookup = DeviceLookup::from_devices(&devices);
        let overrides = tab.get("overrides").unwrap_or(&Value::Null);
        let zone_positions = tab.get("zone_positions").unwrap_or(&Value::Null);
        let zones = tab
            .get("zones_data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut placement_values = Vec::new();

        for zone in zones {
            let Some(member_key) = zone.get("key").and_then(Value::as_str) else {
                continue;
            };
            let Some(resolved_match) = resolved.get(member_key) else {
                continue;
            };
            let position = zone_positions
                .get(member_key)
                .cloned()
                .unwrap_or_else(|| json!({
                    "gridX": zone.get("gridX").and_then(Value::as_f64).unwrap_or(0.0),
                    "gridY": zone.get("gridY").and_then(Value::as_f64).unwrap_or(0.0),
                }));
            let (mut matrix, mut px, mut py, override_led_count) =
                convert_overrides_to_matrix(member_key, overrides, &position);
            let device_id = resolved_match.get("device_id").and_then(Value::as_str);
            let output_id = resolved_match.get("output_id").and_then(Value::as_str);
            let segment_id = resolved_match.get("segment_id").and_then(Value::as_str);
            let Some(device_id) = device_id else {
                continue;
            };
            let Some(output_id) = output_id else {
                continue;
            };
            let snapshot = model::build_snapshot_from_device(&lookup, Some(device_id), output_id, segment_id);

            if matrix.is_none() {
                px = position.get("gridX").and_then(Value::as_f64).unwrap_or(0.0);
                py = position.get("gridY").and_then(Value::as_f64).unwrap_or(0.0);
                matrix = snapshot.as_ref().and_then(|snapshot| snapshot.matrix.clone());
            }

            let actual_leds = snapshot
                .as_ref()
                .map(|snapshot| snapshot.leds_count)
                .filter(|count| *count > 0)
                .unwrap_or(override_led_count);
            let (width, height) = matrix
                .as_ref()
                .map(|matrix| (matrix.width.max(1) as f64, matrix.height.max(1) as f64))
                .unwrap_or_else(|| (actual_leds.max(1) as f64, 1.0));
            placement_values.push(json!({
                "deviceId": device_id,
                "outputId": output_id,
                "segmentId": segment_id,
                "x": px.floor(),
                "y": py.floor(),
                "width": width,
                "height": height,
                "rotation": 0,
                "ledsCount": actual_leds,
                "matrix": matrix,
                "brightness": zone.get("brightness").and_then(Value::as_u64).unwrap_or(100),
                "snapshot": snapshot,
            }));
        }

        if placement_values.is_empty() {
            self.page_emit(json!({ "type": "studio_import_result", "success": false, "error": "no_placements" }));
            return;
        }

        let (min_x, min_y, max_x, max_y) = placement_bounds(&placement_values);
        for placement in &mut placement_values {
            if let Some(object) = placement.as_object_mut() {
                let x = object.get("x").and_then(Value::as_f64).unwrap_or(0.0) - min_x;
                let y = object.get("y").and_then(Value::as_f64).unwrap_or(0.0) - min_y;
                object.insert("x".to_string(), Value::from(x));
                object.insert("y".to_string(), Value::from(y));
            }
        }

        let mut existing_ids = self
            .config
            .layouts
            .iter()
            .map(|layout| layout.id.clone())
            .collect::<HashSet<_>>();
        let mut id_generation_set = existing_ids.clone();
        let new_id = self.rng.next_layout_id(&mut id_generation_set);
        let layout = normalize_layout(
            json!({
                "id": new_id,
                "name": sanitize_layout_name(
                    msg.get("name")
                        .and_then(Value::as_str)
                        .or_else(|| tab.get("name").and_then(Value::as_str)),
                    Some("Studio Import"),
                ),
                "canvas": {
                    "width": (max_x - min_x).max(1.0),
                    "height": (max_y - min_y).max(1.0),
                    "x": 0,
                    "y": 0,
                },
                "placements": placement_values,
                "registered": false,
                "snap_to_grid": false,
            }),
            &mut existing_ids,
            &lookup,
            &mut self.rng,
        );
        let layout_id = layout.id.clone();
        self.config.layouts.push(layout);
        self.config.active_layout_id = layout_id.clone();
        self.save_config();
        self.emit_full_state(Some(&lookup));
        self.page_emit(json!({
            "type": "studio_import_result",
            "success": true,
            "layout_id": layout_id,
        }));
    }
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("{}: {err}", path.display()))?;
    if raw.trim().is_empty() {
        return Err("empty file".to_string());
    }
    serde_json::from_str(&raw).map_err(|err| format!("invalid json: {err}"))
}

fn write_json_file(path: &Path, value: Value) -> Result<(), String> {
    let raw = serde_json::to_vec(&value).map_err(|err| err.to_string())?;
    let tmp = path.with_extension(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}.tmp"))
            .unwrap_or_else(|| "tmp".to_string()),
    );
    fs::write(&tmp, raw).map_err(|err| format!("{}: {err}", tmp.display()))?;
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|err| format!("{} -> {}: {err}", tmp.display(), path.display()))
}

fn find_canvas_frame(frames: &[SkydimoOutputFrameV1]) -> Option<&[SkydimoRgb]> {
    for frame in frames {
        let id = unsafe { ffi_str(frame.output_id.ptr, frame.output_id.len) };
        if id != CANVAS_OUTPUT_ID {
            continue;
        }
        if frame.colors_len == 0 {
            return Some(&[]);
        }
        if frame.colors.is_null() {
            return None;
        }
        let colors = unsafe { std::slice::from_raw_parts(frame.colors, frame.colors_len) };
        return Some(colors);
    }
    None
}

fn studio_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(appdata).join("SkyDimo").join("studio"))
}

fn scan_studio_directory(dir: &Path, host: Host) -> Vec<Value> {
    let mut tabs = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return tabs;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();

    for path in paths {
        match read_json_file(&path) {
            Ok(mut data) => {
                if let Some(object) = data.as_object_mut() {
                    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                        object.insert("_filename".to_string(), Value::String(stem.to_string()));
                    }
                }
                tabs.push(data);
            }
            Err(err) => host.log_warn(&format!(
                "studio import: skipping {}: {err}",
                path.file_name().and_then(|name| name.to_str()).unwrap_or("?")
            )),
        }
    }
    tabs
}

#[derive(Clone, Debug)]
struct ParsedMemberKey {
    vendor: String,
    name: String,
    serial: String,
    zone_name: String,
    segment_index: i64,
}

fn parse_member_key(key: &str) -> Option<ParsedMemberKey> {
    if key.is_empty() {
        return None;
    }
    let seg_pos = key.find("::seg:")?;
    let left = &key[..seg_pos];
    let segment_index = key[seg_pos + 6..].parse::<i64>().unwrap_or(-1);
    let sep = left.find("::")?;
    let device_key = &left[..sep];
    let zone_name = &left[sep + 2..];
    let mut parts = device_key.splitn(3, '|').collect::<Vec<_>>();
    if parts.len() < 3 {
        parts = vec!["", device_key, ""];
    }
    Some(ParsedMemberKey {
        vendor: parts[0].to_string(),
        name: parts[1].to_string(),
        serial: parts[2].to_string(),
        zone_name: zone_name.to_string(),
        segment_index,
    })
}

fn match_studio_to_devices(studio_tab: &Value, current_devices: &Value) -> Value {
    let zones = studio_tab
        .get("zones_data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let overrides = studio_tab.get("overrides").unwrap_or(&Value::Null);
    let mut device_order = Vec::new();
    let mut zones_by_device: HashMap<String, Vec<Value>> = HashMap::new();

    for zone in zones {
        let Some(device_key) = zone.get("deviceKey").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
            continue;
        };
        if !zones_by_device.contains_key(device_key) {
            device_order.push(device_key.to_string());
            zones_by_device.insert(device_key.to_string(), Vec::new());
        }
        if let Some(device_zones) = zones_by_device.get_mut(device_key) {
            device_zones.push(zone);
        }
    }

    let devices = current_devices.as_array().cloned().unwrap_or_default();
    let results = device_order
        .into_iter()
        .map(|old_device_key| {
            let parsed = parse_member_key(&format!("{old_device_key}::_::seg:-1"));
            let vendor = parsed.as_ref().map(|parsed| parsed.vendor.as_str()).unwrap_or("");
            let name = parsed
                .as_ref()
                .map(|parsed| parsed.name.as_str())
                .unwrap_or(old_device_key.as_str());
            let serial = parsed.as_ref().map(|parsed| parsed.serial.as_str()).unwrap_or("");
            let mut candidates = devices
                .iter()
                .filter_map(|device| {
                    let score = score_device_match(vendor, name, serial, device);
                    (score > 0).then(|| {
                        json!({
                            "device_id": device.get("id").and_then(Value::as_str).unwrap_or(""),
                            "score": score,
                            "device_name": device
                                .get("name")
                                .or_else(|| device.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            "serial_id": device.get("serial_id").and_then(Value::as_str).unwrap_or(""),
                        })
                    })
                })
                .collect::<Vec<_>>();
            candidates.sort_by(|a, b| {
                b.get("score")
                    .and_then(Value::as_i64)
                    .cmp(&a.get("score").and_then(Value::as_i64))
            });
            let auto_match = auto_match_device(&candidates);
            let matched_device = auto_match
                .as_ref()
                .and_then(|candidate| candidate.get("device_id"))
                .and_then(Value::as_str)
                .and_then(|device_id| {
                    devices
                        .iter()
                        .find(|device| device.get("id").and_then(Value::as_str) == Some(device_id))
                });
            let zone_matches = if let Some(device) = matched_device {
                match_zones_to_outputs(
                    zones_by_device
                        .get(&old_device_key)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                    device,
                    overrides,
                )
            } else {
                zones_without_output_matches(
                    zones_by_device
                        .get(&old_device_key)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                )
            };

            json!({
                "old_device_key": old_device_key,
                "vendor": vendor,
                "name": name,
                "serial": serial,
                "candidates": candidates,
                "auto_match": auto_match,
                "zones": zone_matches,
            })
        })
        .collect::<Vec<_>>();

    Value::Array(results)
}

fn auto_match_device(candidates: &[Value]) -> Option<Value> {
    if candidates.len() == 1 {
        return Some(candidates[0].clone());
    }
    if candidates.len() > 1 {
        let top = candidates[0].get("score").and_then(Value::as_i64).unwrap_or(0);
        let second = candidates[1].get("score").and_then(Value::as_i64).unwrap_or(0);
        if top >= 50 && top > second {
            return Some(candidates[0].clone());
        }
    }
    None
}

fn score_device_match(old_vendor: &str, old_name: &str, old_serial: &str, device: &Value) -> i64 {
    let mut score = 0;
    let dev_serial = device.get("serial_id").and_then(Value::as_str).unwrap_or("");
    let dev_name = lower_field(device, "name");
    let dev_model = lower_field(device, "model");
    let dev_id = device.get("id").and_then(Value::as_str).unwrap_or("");

    if !old_serial.is_empty() && !dev_serial.is_empty() {
        if old_serial == dev_serial {
            score += 100;
        } else if dev_serial.contains(old_serial) || old_serial.contains(dev_serial) {
            score += 50;
        }
    }
    if !old_serial.is_empty() && score < 50 {
        if let Some(id_serial) = dev_id.split('-').nth(2) {
            if old_serial == id_serial {
                score += 100;
            } else if id_serial.contains(old_serial) || old_serial.contains(id_serial) {
                score += 50;
            }
        }
    }

    let old_name_lower = old_name.to_ascii_lowercase();
    if !old_name_lower.is_empty() {
        if old_name_lower == dev_name || old_name_lower == dev_model {
            score += 40;
        } else if dev_name.contains(&old_name_lower)
            || old_name_lower.contains(&dev_name)
            || (!dev_model.is_empty()
                && (dev_model.contains(&old_name_lower) || old_name_lower.contains(&dev_model)))
        {
            score += 20;
        }
    }

    if !old_vendor.is_empty() {
        let dev_vendor = lower_field(device, "manufacturer");
        if !dev_vendor.is_empty() && old_vendor.eq_ignore_ascii_case(&dev_vendor) {
            score += 10;
        }
    }

    score
}

fn lower_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn match_zones_to_outputs(zones: &[Value], device: &Value, overrides: &Value) -> Value {
    let outputs = device
        .get("outputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let results = zones
        .iter()
        .filter_map(|zone| {
            let parsed = parse_member_key(zone.get("key")?.as_str()?)?;
            let output_candidates = outputs
                .iter()
                .map(|output| {
                    json!({
                        "output_id": output.get("id").and_then(Value::as_str).unwrap_or(""),
                        "output_name": output
                            .get("name")
                            .or_else(|| output.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        "segments": output
                            .get("segments")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                        "leds_count": output.get("leds_count").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>();
            let (auto_output, auto_segment_id) =
                auto_match_output(&outputs, &parsed.zone_name, parsed.segment_index);
            let old_leds_count = old_led_count_from_overrides(overrides.get(zone.get("key")?.as_str()?));
            let new_leds_count = auto_output
                .as_ref()
                .map(|output| {
                    if let Some(segment_id) = auto_segment_id.as_deref() {
                        output
                            .get("segments")
                            .and_then(Value::as_array)
                            .and_then(|segments| {
                                segments.iter().find(|segment| {
                                    segment.get("id").and_then(Value::as_str) == Some(segment_id)
                                })
                            })
                            .and_then(|segment| segment.get("leds_count"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                    } else {
                        output.get("leds_count").and_then(Value::as_u64).unwrap_or(0)
                    }
                })
                .unwrap_or(0);

            Some(json!({
                "member_key": zone.get("key").and_then(Value::as_str).unwrap_or(""),
                "zone_name": parsed.zone_name,
                "segment_index": parsed.segment_index,
                "output_candidates": output_candidates,
                "auto_match_output": auto_output.as_ref().map(|output| {
                    json!({
                        "output_id": output.get("id").and_then(Value::as_str).unwrap_or(""),
                        "segment_id": auto_segment_id,
                    })
                }),
                "old_leds_count": old_leds_count,
                "new_leds_count": new_leds_count,
                "brightness": zone.get("brightness").and_then(Value::as_u64).unwrap_or(100),
            }))
        })
        .collect::<Vec<_>>();
    Value::Array(results)
}

fn zones_without_output_matches(zones: &[Value]) -> Value {
    Value::Array(
        zones
            .iter()
            .filter_map(|zone| {
                let key = zone.get("key")?.as_str()?;
                let parsed = parse_member_key(key);
                Some(json!({
                    "member_key": key,
                    "zone_name": parsed.as_ref().map(|parsed| parsed.zone_name.as_str()).unwrap_or("?"),
                    "segment_index": parsed.as_ref().map(|parsed| parsed.segment_index).unwrap_or(-1),
                    "output_candidates": [],
                    "auto_match_output": Value::Null,
                    "old_leds_count": 0,
                    "new_leds_count": 0,
                    "brightness": zone.get("brightness").and_then(Value::as_u64).unwrap_or(100),
                }))
            })
            .collect(),
    )
}

fn auto_match_output(outputs: &[Value], zone_name: &str, segment_index: i64) -> (Option<Value>, Option<String>) {
    let auto_output = if outputs.len() == 1 {
        outputs.first().cloned()
    } else {
        let zone_lower = zone_name.to_ascii_lowercase();
        let mut best: Option<(u8, Value)> = None;
        for output in outputs {
            let output_name = output
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let match_type = if output_name == zone_lower {
                2
            } else if output_name.contains(&zone_lower) || zone_lower.contains(&output_name) {
                1
            } else {
                0
            };
            if match_type > best.as_ref().map(|(score, _)| *score).unwrap_or(0) {
                best = Some((match_type, output.clone()));
            }
        }
        best.map(|(_, output)| output)
    };

    let segment_id = auto_output.as_ref().and_then(|output| {
        let segments = output.get("segments").and_then(Value::as_array)?;
        if segment_index == -1 {
            (segments.len() == 1)
                .then(|| segments[0].get("id").and_then(Value::as_str).map(str::to_string))
                .flatten()
        } else {
            segments
                .get(segment_index as usize)
                .and_then(|segment| segment.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        }
    });

    (auto_output, segment_id)
}

fn old_led_count_from_overrides(override_value: Option<&Value>) -> u64 {
    override_value
        .and_then(Value::as_object)
        .map(|override_map| {
            override_map
                .keys()
                .filter_map(|key| key.parse::<u64>().ok())
                .max()
                .map(|max_index| max_index + 1)
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

fn convert_overrides_to_matrix(
    member_key: &str,
    overrides: &Value,
    zone_position: &Value,
) -> (Option<Matrix>, f64, f64, usize) {
    let Some(override_map) = overrides.get(member_key).and_then(Value::as_object) else {
        return (None, 0.0, 0.0, 0);
    };
    if override_map.is_empty() {
        return (None, 0.0, 0.0, 0);
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut max_led_idx: i64 = -1;

    for (led_idx, pos) in override_map {
        let x = pos.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = pos.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        if let Ok(index) = led_idx.parse::<i64>() {
            max_led_idx = max_led_idx.max(index);
        }
    }

    if max_led_idx < 0 {
        return (None, 0.0, 0.0, 0);
    }

    let width = ((max_x - min_x + 1.0).floor() as isize).max(1) as usize;
    let height = ((max_y - min_y + 1.0).floor() as isize).max(1) as usize;
    let mut map = vec![-1; width.saturating_mul(height)];

    for (led_idx, pos) in override_map {
        let Ok(led_idx) = led_idx.parse::<i64>() else {
            continue;
        };
        let col = (pos.get("x").and_then(Value::as_f64).unwrap_or(0.0) - min_x).floor() as isize;
        let row = (pos.get("y").and_then(Value::as_f64).unwrap_or(0.0) - min_y).floor() as isize;
        if col < 0 || row < 0 {
            continue;
        }
        let index = row as usize * width + col as usize;
        if let Some(slot) = map.get_mut(index) {
            *slot = led_idx;
        }
    }

    let grid_x = zone_position.get("gridX").and_then(Value::as_f64).unwrap_or(0.0) + min_x;
    let grid_y = zone_position.get("gridY").and_then(Value::as_f64).unwrap_or(0.0) + min_y;
    (
        Some(Matrix { width, height, map }),
        grid_x,
        grid_y,
        (max_led_idx + 1) as usize,
    )
}

fn placement_bounds(placements: &[Value]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for placement in placements {
        let x = placement.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = placement.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let width = placement.get("width").and_then(Value::as_f64).unwrap_or(1.0);
        let height = placement.get("height").and_then(Value::as_f64).unwrap_or(1.0);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width);
        max_y = max_y.max(y + height);
    }
    if !min_x.is_finite() {
        (0.0, 0.0, 1.0, 1.0)
    } else {
        (min_x, min_y, max_x, max_y)
    }
}

unsafe extern "C" fn led_canvas_create(
    host: *const SkydimoHostApiV1,
    out_instance: *mut *mut c_void,
) -> i32 {
    if out_instance.is_null() {
        return -1;
    }
    let extension = Box::new(unsafe { LedCanvasExtension::new(host) });
    unsafe {
        *out_instance = Box::into_raw(extension).cast::<c_void>();
    }
    0
}

unsafe extern "C" fn led_canvas_destroy(instance: *mut c_void) {
    if !instance.is_null() {
        unsafe {
            drop(Box::from_raw(instance.cast::<LedCanvasExtension>()));
        }
    }
}

unsafe extern "C" fn led_canvas_start(instance: *mut c_void) -> i32 {
    let Some(extension) = extension_mut(instance) else {
        return -1;
    };
    status(extension.start())
}

unsafe extern "C" fn led_canvas_stop(instance: *mut c_void) -> i32 {
    let Some(extension) = extension_mut(instance) else {
        return -1;
    };
    status(extension.stop())
}

unsafe extern "C" fn led_canvas_on_scan_devices(_instance: *mut c_void) -> i32 {
    0
}

unsafe extern "C" fn led_canvas_on_event_json(
    instance: *mut c_void,
    event_ptr: *const c_char,
    event_len: usize,
    data_ptr: *const c_char,
    data_len: usize,
) -> i32 {
    let Some(extension) = extension_mut(instance) else {
        return -1;
    };
    let event = unsafe { ffi_str(event_ptr, event_len) };
    let data = json_from_raw(data_ptr, data_len);
    extension.on_event_json(&event, data);
    0
}

unsafe extern "C" fn led_canvas_on_page_message_json(
    instance: *mut c_void,
    ptr: *const c_char,
    len: usize,
) -> i32 {
    let Some(extension) = extension_mut(instance) else {
        return -1;
    };
    extension.on_page_message(json_from_raw(ptr, len));
    0
}

unsafe extern "C" fn led_canvas_on_device_frame(
    instance: *mut c_void,
    port_ptr: *const c_char,
    port_len: usize,
    frames: *const SkydimoOutputFrameV1,
    frame_count: usize,
) -> i32 {
    let Some(extension) = extension_mut(instance) else {
        return -1;
    };
    let port = unsafe { ffi_str(port_ptr, port_len) };
    if frames.is_null() && frame_count > 0 {
        return -1;
    }
    let frames = if frame_count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(frames, frame_count) }
    };
    extension.on_device_frame(port, frames);
    0
}

#[no_mangle]
/// # Safety
///
/// `out_api` must be a valid writable pointer supplied by the Skydimo host.
/// The host must pass the ABI version it expects in `requested_abi_version`.
pub unsafe extern "C" fn skydimo_plugin_get_api(
    requested_abi_version: u32,
    _host: *const SkydimoHostApiV1,
    out_api: *mut SkydimoPluginApiV1,
) -> i32 {
    if out_api.is_null() || requested_abi_version != SKYDIMO_NATIVE_C_ABI_VERSION {
        return -1;
    }

    unsafe {
        *out_api = SkydimoPluginApiV1 {
            size: std::mem::size_of::<SkydimoPluginApiV1>() as u32,
            abi_version: SKYDIMO_NATIVE_C_ABI_VERSION,
            kind_mask: SKYDIMO_PLUGIN_KIND_EXTENSION,
            effect: SkydimoEffectApiV1 {
                size: std::mem::size_of::<SkydimoEffectApiV1>() as u32,
                ..SkydimoEffectApiV1::default()
            },
            controller: SkydimoControllerApiV1 {
                size: std::mem::size_of::<SkydimoControllerApiV1>() as u32,
                ..SkydimoControllerApiV1::default()
            },
            extension: SkydimoExtensionApiV1 {
                size: std::mem::size_of::<SkydimoExtensionApiV1>() as u32,
                create: Some(led_canvas_create),
                destroy: Some(led_canvas_destroy),
                start: Some(led_canvas_start),
                stop: Some(led_canvas_stop),
                on_scan_devices: Some(led_canvas_on_scan_devices),
                on_event_json: Some(led_canvas_on_event_json),
                on_page_message_json: Some(led_canvas_on_page_message_json),
                on_device_frame: Some(led_canvas_on_device_frame),
            },
            shutdown_plugin: None,
        };
    }
    0
}

unsafe fn extension_mut(instance: *mut c_void) -> Option<&'static mut LedCanvasExtension> {
    if instance.is_null() {
        None
    } else {
        Some(unsafe { &mut *instance.cast::<LedCanvasExtension>() })
    }
}

fn status(result: Result<(), String>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

fn json_from_raw(ptr: *const c_char, len: usize) -> Value {
    if ptr.is_null() || len == 0 {
        return Value::Null;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) };
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}
