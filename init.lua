--- led_canvas extension — multi-layout canvas virtual devices & routing engine
--
-- Each layout registers its own virtual canvas device. Layout state is
-- persisted immediately, even before registration, and each layout is backed
-- by its own JSON file keyed by a generated 9-char uppercase alpha-numeric id.

local routing = require("lib.routing")
local persist = require("lib.persist")
local json    = require("lib.json")

local P = {}

-- ── Constants ─────────────────────────────────────────────────────────
local CANVAS_PORT_PREFIX    = "ext:led_canvas:canvas"
local CANVAS_OUTPUT_ID     = "canvas"
local CANVAS_MANUFACTURER  = "LedCanvas"
local DEFAULT_GRID_W     = 64
local DEFAULT_GRID_H     = 64
local MAX_GRID_SIDE      = 256
local MAX_LAYOUT_NAME_CHARS = 64
local EMPTY_MATRIX_CELL  = -1
local LAYOUT_ID_LENGTH   = 9
local LAYOUT_ID_CHARS    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

-- ── State ─────────────────────────────────────────────────────────────
local config            = nil   -- Full persisted configuration table
local routing_tables      = {}  -- layout_id → routing table
local core_locked_outputs = {}  -- output_key → { port, outputId, indices_set }
local placement_led_status = {} -- layout_id → { placement_id → { blockedLedIndices, blockedLedCount, availableLedCount } }
local random_seeded       = false

-- ── Helpers ───────────────────────────────────────────────────────────

local function ensure_random_seed()
    if random_seeded then
        return
    end

    local seed = os.time() + math.floor((os.clock() % 1) * 1000000)
    math.randomseed(seed)

    -- Throw away the first few values to reduce weak initial sequences.
    math.random()
    math.random()
    math.random()

    random_seeded = true
end

local function sanitize_canvas_side(value, fallback)
    local n = tonumber(value)
    if not n then n = fallback end
    n = math.floor(n + 0.5)
    if n < 1 then n = 1 end
    if n > MAX_GRID_SIDE then n = MAX_GRID_SIDE end
    return n
end

local function sanitize_non_negative_int(value, fallback)
    local n = tonumber(value)
    if not n then n = fallback end
    n = math.floor(n + 0.5)
    if n < 0 then n = 0 end
    return n
end

local function normalize_rotation(value)
    local n = tonumber(value)
    if not n or n ~= n then
        return 0
    end
    n = n % 360
    if n < 0 then
        n = n + 360
    end
    return n
end

local function sanitize_brightness(value)
    local n = tonumber(value)
    if not n or n ~= n then return 100 end
    return math.floor(math.max(0, math.min(100, n)) + 0.5)
end

local function clone_plain_value(value, seen)
    if type(value) ~= "table" or value == json.null then
        return value
    end

    seen = seen or {}
    if seen[value] then
        return seen[value]
    end

    local copy = {}
    seen[value] = copy
    for k, v in pairs(value) do
        copy[clone_plain_value(k, seen)] = clone_plain_value(v, seen)
    end
    return copy
end

local function sanitize_virtual_device_params(value)
    if type(value) ~= "table" or value == json.null then
        return {}
    end
    return clone_plain_value(value)
end

local function plain_values_equal(left, right, seen)
    if left == right then
        return true
    end

    if type(left) ~= type(right) then
        return false
    end

    if type(left) ~= "table" then
        return false
    end

    if left == json.null or right == json.null then
        return left == right
    end

    seen = seen or {}
    if seen[left] == right then
        return true
    end
    seen[left] = right

    for key, left_value in pairs(left) do
        if not plain_values_equal(left_value, right[key], seen) then
            return false
        end
    end

    for key in pairs(right) do
        if left[key] == nil then
            return false
        end
    end

    return true
end

local function normalize_virtual_device_config(value)
    local raw = type(value) == "table" and value or {}
    local effect_id = raw.effect_id
    if type(effect_id) ~= "string" or effect_id == "" then
        effect_id = nil
    end

    return {
        power_on = raw.power_on ~= false,
        effect_id = effect_id,
        effect_params = effect_id and sanitize_virtual_device_params(raw.effect_params) or {},
    }
end

local function get_effect_params_schema(effect_id)
    if type(effect_id) ~= "string" or effect_id == "" then
        return {}
    end

    local ok, params = pcall(ext.get_effect_params, effect_id)
    if not ok then
        ext.warn("get_effect_params failed for " .. tostring(effect_id) .. ": " .. tostring(params))
        return {}
    end

    if type(params) ~= "table" then
        return {}
    end

    return clone_plain_value(params)
end

local function build_default_effect_params_from_schema(schema)
    local defaults = {}
    if type(schema) ~= "table" then
        return defaults
    end

    for _, param in ipairs(schema) do
        if type(param) == "table" and type(param.key) == "string" then
            local default_value = param.default
            if default_value ~= nil and default_value ~= json.null then
                defaults[param.key] = clone_plain_value(default_value)
            end
        end
    end

    return defaults
end

local function build_default_effect_params(effect_id)
    return build_default_effect_params_from_schema(get_effect_params_schema(effect_id))
end

local function build_effect_catalog()
    local ok, effects = pcall(ext.get_effects)
    if not ok then
        ext.warn("get_effects failed: " .. tostring(effects))
        return {}
    end

    if type(effects) ~= "table" then
        return {}
    end

    local catalog = {}
    for _, effect in ipairs(effects) do
        if type(effect) == "table" and type(effect.id) == "string" and effect.id ~= "" then
            catalog[#catalog + 1] = {
                id = effect.id,
                name = clone_plain_value(effect.name),
                description = clone_plain_value(effect.description),
                group = clone_plain_value(effect.group),
                icon = effect.icon,
                params = get_effect_params_schema(effect.id),
            }
        end
    end

    return catalog
end

local function is_valid_layout_id(value)
    return type(value) == "string"
        and #value == LAYOUT_ID_LENGTH
        and value:match("^[A-Z0-9]+$") ~= nil
end

local function collect_layout_ids(layouts)
    local ids = {}
    if type(layouts) ~= "table" then
        return ids
    end

    for _, layout in ipairs(layouts) do
        if type(layout) == "table" and type(layout.id) == "string" then
            ids[layout.id] = true
        end
    end

    return ids
end

local function generate_layout_id(existing_ids)
    ensure_random_seed()

    local taken = existing_ids or {}
    while true do
        local value = {}
        for i = 1, LAYOUT_ID_LENGTH do
            local idx = math.random(1, #LAYOUT_ID_CHARS)
            value[i] = LAYOUT_ID_CHARS:sub(idx, idx)
        end

        local candidate = table.concat(value)
        if not taken[candidate] then
            taken[candidate] = true
            return candidate
        end
    end
end

--- Trim whitespace and return a non-empty string, or fallback, or "Canvas".
local function truncate_utf8(value, max_chars)
    local ok, cutoff = pcall(utf8.offset, value, max_chars + 1)
    if ok and cutoff then
        return value:sub(1, cutoff - 1)
    end
    return value
end

local function sanitize_layout_name(value, fallback)
    for _, raw in ipairs({ value, fallback }) do
        if type(raw) == "string" then
            local trimmed = raw:match("^%s*(.-)%s*$")
            if trimmed ~= "" then
                return truncate_utf8(trimmed, MAX_LAYOUT_NAME_CHARS)
            end
        end
    end
    return "Canvas"
end

local function normalize_matrix(matrix, leds_count)
    if type(matrix) ~= "table" or matrix == json.null then
        return nil
    end

    local width = sanitize_non_negative_int(matrix.width, 0)
    local height = sanitize_non_negative_int(matrix.height, 0)
    if width <= 0 or height <= 0 then
        return nil
    end

    local source = type(matrix.map) == "table" and matrix.map or {}
    local total = width * height
    local normalized = {}

    for idx = 1, total do
        local raw = tonumber(source[idx])
        if raw and raw >= 0 then
            local led_idx = math.floor(raw)
            if leds_count <= 0 or led_idx < leds_count then
                normalized[idx] = led_idx
            else
                normalized[idx] = EMPTY_MATRIX_CELL
            end
        else
            normalized[idx] = EMPTY_MATRIX_CELL
        end
    end

    return {
        width = width,
        height = height,
        map = normalized,
    }
end

local function is_canvas_device(device)
    return type(device) == "table"
        and device.manufacturer == CANVAS_MANUFACTURER
end

local function filter_devices_for_page(devices)
    if type(devices) ~= "table" then return {} end
    local result = {}
    for _, device in ipairs(devices) do
        if type(device) == "table" and not is_canvas_device(device) then
            result[#result + 1] = device
        end
    end
    return result
end

local function build_device_lookup(devices)
    local lookup = {
        by_id = {},
        by_port = {},
    }

    if type(devices) ~= "table" then
        return lookup
    end

    for _, device in ipairs(devices) do
        if type(device) == "table" and not is_canvas_device(device) then
            if type(device.id) == "string" and device.id ~= "" and not lookup.by_id[device.id] then
                lookup.by_id[device.id] = device
            end
            if type(device.port) == "string" and device.port ~= "" then
                lookup.by_port[device.port] = device
            end
        end
    end

    return lookup
end

local function get_device_lookup(devices)
    if type(devices) == "table" then
        return build_device_lookup(devices)
    end

    local ok, current_devices = pcall(ext.get_devices)
    if not ok then
        ext.log("warn: failed to query devices: " .. tostring(current_devices))
        return build_device_lookup({})
    end

    return build_device_lookup(current_devices)
end

local function resolve_device_id(device_lookup, device_id, port)
    if type(device_id) == "string" and device_id ~= "" then
        return device_id
    end

    if type(port) == "string" and port ~= "" then
        local device = device_lookup.by_port[port]
        if type(device) == "table" and type(device.id) == "string" and device.id ~= "" then
            return device.id
        end
    end

    return nil
end

local function resolve_runtime_port(device_lookup, placement)
    if type(placement) ~= "table" then
        return nil
    end

    if type(placement.deviceId) == "string" and placement.deviceId ~= "" then
        local device = device_lookup.by_id[placement.deviceId]
        if type(device) == "table" and type(device.port) == "string" and device.port ~= "" then
            return device.port
        end
    end

    local fallback_port = placement.legacyPort or placement.port
    if type(fallback_port) == "string" and fallback_port ~= "" then
        local device = device_lookup.by_port[fallback_port]
        if type(device) == "table" and type(device.port) == "string" and device.port ~= "" then
            return device.port
        end
    end

    return nil
end

--- Build local LED indices from a matrix or sequential range.
local function build_local_indices(matrix, count)
    if type(matrix) == "table" and type(matrix.map) == "table" then
        local indices = {}
        local seen = {}
        for _, mapped in ipairs(matrix.map) do
            local value = tonumber(mapped)
            if value and value >= 0 then
                local local_index = math.floor(value)
                if local_index < count and not seen[local_index] then
                    seen[local_index] = true
                    indices[#indices + 1] = local_index
                end
            end
        end
        table.sort(indices)
        return indices
    end

    local indices = {}
    for i = 0, count - 1 do
        indices[#indices + 1] = i
    end
    return indices
end

local function runtime_placement(placement, device_lookup)
    local port = resolve_runtime_port(device_lookup, placement)
    if not port then
        return nil
    end

    -- Resolve leds_count and base_index from device/output/segment info.
    local base_index = 0
    local leds_count = sanitize_non_negative_int(placement.ledsCount, 0)

    local device = device_lookup.by_port[port]
    if type(device) == "table" and type(device.outputs) == "table" then
        local output = nil
        for _, candidate in ipairs(device.outputs) do
            if type(candidate) == "table" and candidate.id == placement.outputId then
                output = candidate
                break
            end
        end

        if type(output) == "table" then
            local output_leds = sanitize_non_negative_int(output.leds_count, leds_count)
            local segment_id = placement.segmentId

            if type(segment_id) == "string" and segment_id ~= "" and type(output.segments) == "table" then
                local offset = 0
                for _, segment in ipairs(output.segments) do
                    local seg_leds = sanitize_non_negative_int(segment.leds_count, 0)
                    if type(segment) == "table" and segment.id == segment_id then
                        if seg_leds > 0 and (leds_count <= 0 or leds_count > seg_leds) then
                            leds_count = seg_leds
                        end
                        base_index = offset
                        break
                    end
                    offset = offset + seg_leds
                end
            elseif output_leds > 0 and (leds_count <= 0 or leds_count > output_leds) then
                leds_count = output_leds
            end
        end
    end

    local local_indices = build_local_indices(placement.matrix, leds_count)
    local actual_indices = {}
    for _, li in ipairs(local_indices) do
        actual_indices[#actual_indices + 1] = base_index + li
    end

    return {
        id = placement.id,
        deviceId = placement.deviceId,
        name = placement.name,
        port = port,
        outputId = placement.outputId,
        segmentId = placement.segmentId,
        x = placement.x,
        y = placement.y,
        width = placement.width,
        height = placement.height,
        rotation = normalize_rotation(placement.rotation),
        ledsCount = leds_count,
        matrix = placement.matrix,
        brightness = placement.brightness or 100,
        localIndices = local_indices,
        actualIndices = actual_indices,
    }
end

local function placement_lock_key(placement)
    return tostring(placement.port or placement.legacyPort or "") .. "::" .. tostring(placement.outputId or "")
end

local function placement_routing_key(placement)
    local key = placement_lock_key(placement)
    if type(placement.segmentId) == "string" and placement.segmentId ~= "" then
        key = key .. "::" .. placement.segmentId
    end
    return key
end

--- Normalize a snapshot table (ledsCount, matrix, name).
local function normalize_snapshot(snapshot, leds_count)
    if type(snapshot) ~= "table" or snapshot == json.null then
        return nil
    end
    local snap_leds = sanitize_non_negative_int(snapshot.ledsCount or snapshot.leds_count, 0)
    if snap_leds <= 0 then
        return nil
    end
    return {
        ledsCount = snap_leds,
        matrix = normalize_matrix(snapshot.matrix, snap_leds),
        name = type(snapshot.name) == "string" and snapshot.name or nil,
    }
end

--- Build a snapshot from the current live device state for a given placement.
local function build_snapshot_from_device(device_lookup, device_id, output_id, segment_id)
    if not device_id or device_id == "" then
        return nil
    end
    local device = device_lookup.by_id[device_id]
    if type(device) ~= "table" or type(device.outputs) ~= "table" then
        return nil
    end

    for _, output in ipairs(device.outputs) do
        if type(output) == "table" and output.id == output_id then
            if type(segment_id) == "string" and segment_id ~= "" and type(output.segments) == "table" then
                for _, segment in ipairs(output.segments) do
                    if type(segment) == "table" and segment.id == segment_id then
                        local leds = sanitize_non_negative_int(segment.leds_count, 0)
                        return {
                            ledsCount = leds,
                            matrix = normalize_matrix(segment.matrix, leds),
                            name = segment.name or output.name or nil,
                        }
                    end
                end
                return nil
            end

            local leds = sanitize_non_negative_int(output.leds_count, 0)
            return {
                ledsCount = leds,
                matrix = normalize_matrix(output.matrix, leds),
                name = output.name or nil,
            }
        end
    end

    return nil
end

--- Compare a snapshot against the current live device state.
--- Returns true if the device has changed since the snapshot was taken.
local function is_placement_stale(snapshot, device_lookup, device_id, output_id, segment_id)
    if not snapshot then
        return false
    end
    local live = build_snapshot_from_device(device_lookup, device_id, output_id, segment_id)
    if not live then
        -- Device is offline; not considered stale.
        return false
    end
    if snapshot.ledsCount ~= live.ledsCount then
        return true
    end
    -- Compare matrix dimensions.
    local snap_mat = snapshot.matrix
    local live_mat = live.matrix
    if (snap_mat == nil) ~= (live_mat == nil) then
        return true
    end
    if snap_mat and live_mat then
        if snap_mat.width ~= live_mat.width or snap_mat.height ~= live_mat.height then
            return true
        end
    end
    return false
end

local function normalize_placements(placements, device_lookup)
    local normalized = {}
    if type(placements) ~= "table" then
        return normalized
    end

    local lookup = device_lookup or get_device_lookup()
    local seen_ids = {}

    for _, placement in ipairs(placements) do
        if type(placement) == "table" and placement.outputId and (placement.deviceId or placement.port or placement.legacyPort) then
            local placement_id = placement.id
            if not is_valid_layout_id(placement_id) or seen_ids[placement_id] then
                placement_id = generate_layout_id(seen_ids)
            end
            seen_ids[placement_id] = true
            local leds_count = sanitize_non_negative_int(
                placement.ledsCount or placement.leds_count,
                0
            )
            local device_id = resolve_device_id(lookup, placement.deviceId, placement.port or placement.legacyPort)
            local legacy_port = placement.legacyPort
            if (type(legacy_port) ~= "string" or legacy_port == "") and type(placement.port) == "string" and placement.port ~= "" then
                legacy_port = placement.port
            end
            if device_id then
                legacy_port = nil
            end

            -- Persist the snapshot if provided; otherwise try to build one from the current device state.
            local snapshot = normalize_snapshot(placement.snapshot, leds_count)
            if not snapshot then
                snapshot = build_snapshot_from_device(lookup, device_id, placement.outputId,
                    placement.segmentId ~= json.null and placement.segmentId or nil)
            end

            normalized[#normalized + 1] = {
                id = placement_id,
                deviceId = device_id,
                name = placement.name,
                legacyPort = legacy_port,
                outputId = placement.outputId,
                segmentId = placement.segmentId ~= json.null and placement.segmentId or nil,
                x = tonumber(placement.x) or 0,
                y = tonumber(placement.y) or 0,
                width = math.max(1, tonumber(placement.width) or 1),
                height = math.max(1, tonumber(placement.height) or 1),
                rotation = normalize_rotation(placement.rotation or placement.angle),
                ledsCount = leds_count,
                matrix = normalize_matrix(placement.matrix, leds_count),
                brightness = sanitize_brightness(placement.brightness),
                snapshot = snapshot,
            }
        end
    end

    return normalized
end

local function normalize_layout(layout, existing_ids, device_lookup)
    local normalized = type(layout) == "table" and layout or {}
    local preferred_id = normalized.id or normalized.serial_id or normalized.serial
    if is_valid_layout_id(preferred_id) and not existing_ids[preferred_id] then
        normalized.id = preferred_id
        existing_ids[preferred_id] = true
    else
        normalized.id = generate_layout_id(existing_ids)
    end
    normalized.name = sanitize_layout_name(normalized.name, normalized.id)
    normalized.registered = normalized.registered == true
    normalized.snap_to_grid = normalized.snap_to_grid == true
    normalized.canvas = {
        width = sanitize_canvas_side(normalized.canvas and normalized.canvas.width, DEFAULT_GRID_W),
        height = sanitize_canvas_side(normalized.canvas and normalized.canvas.height, DEFAULT_GRID_H),
        x = tonumber(normalized.canvas and normalized.canvas.x) or 0,
        y = tonumber(normalized.canvas and normalized.canvas.y) or 0,
    }
    normalized.placements = normalize_placements(normalized.placements, device_lookup)
    normalized.virtual_device = normalize_virtual_device_config(normalized.virtual_device)
    normalized.serial = nil
    normalized.serial_id = nil
    return normalized
end

local function normalize_config(raw, device_lookup)
    local normalized = type(raw) == "table" and raw or {}
    normalized.version = normalized.version or 1
    normalized.layouts = type(normalized.layouts) == "table" and normalized.layouts or {}

    local layouts = {}
    local existing_ids = {}
    for _, layout in ipairs(normalized.layouts) do
        layouts[#layouts + 1] = normalize_layout(layout, existing_ids, device_lookup)
    end

    if #layouts == 0 then
        layouts[1] = normalize_layout({
            name = "Default",
            registered = false,
            canvas = { width = DEFAULT_GRID_W, height = DEFAULT_GRID_H, x = 0, y = 0 },
            placements = {},
            snap_to_grid = false,
        }, existing_ids, device_lookup)
    end

    normalized.layouts = layouts
    normalized.active_layout_id = normalized.active_layout_id or layouts[1].id
    local active_exists = false
    for _, layout in ipairs(layouts) do
        if layout.id == normalized.active_layout_id then
            active_exists = true
            break
        end
    end
    if not active_exists then
        normalized.active_layout_id = layouts[1].id
    end

    return normalized
end

--- Build a flat identity matrix map: { 0, 1, 2, ... }.
local function identity_matrix_map(width, height)
    local map = {}
    local total = width * height
    for i = 0, total - 1 do
        map[#map + 1] = i
    end
    return map
end

--- Derive the unique port name for a layout.
local function layout_port(layout_id)
    return CANVAS_PORT_PREFIX .. ":" .. layout_id
end

local function layout_scope(layout)
    return {
        port = layout_port(layout.id),
        output_id = CANVAS_OUTPUT_ID,
    }
end

local function set_layout_virtual_power(layout, power_on)
    if type(layout.virtual_device) ~= "table" then
        layout.virtual_device = normalize_virtual_device_config(nil)
    end

    layout.virtual_device.power_on = power_on ~= false
    if not layout.registered then
        return true
    end

    local ok, err = pcall(ext.set_scope_power, layout_scope(layout), not layout.virtual_device.power_on)
    if not ok then
        return false, err
    end

    return true
end

local function set_layout_virtual_effect(layout, effect_id)
    if type(layout.virtual_device) ~= "table" then
        layout.virtual_device = normalize_virtual_device_config(nil)
    end

    local next_effect_id = effect_id
    if type(next_effect_id) ~= "string" or next_effect_id == "" then
        next_effect_id = nil
    end

    layout.virtual_device.effect_id = next_effect_id
    layout.virtual_device.effect_params = next_effect_id and build_default_effect_params(next_effect_id) or {}

    if not layout.registered then
        return true
    end

    local params = next(layout.virtual_device.effect_params) and layout.virtual_device.effect_params or nil
    local ok, err = pcall(ext.set_scope_effect, layout_scope(layout), next_effect_id, params)
    if not ok then
        return false, err
    end

    return true
end

local function update_layout_virtual_effect_params(layout, params)
    if type(layout.virtual_device) ~= "table" then
        layout.virtual_device = normalize_virtual_device_config(nil)
    end

    if type(layout.virtual_device.effect_id) ~= "string" or layout.virtual_device.effect_id == "" then
        layout.virtual_device.effect_params = {}
        return true
    end

    layout.virtual_device.effect_params = sanitize_virtual_device_params(params)
    if not layout.registered then
        return true
    end

    local ok, err = pcall(ext.update_scope_effect_params, layout_scope(layout), layout.virtual_device.effect_params)
    if not ok then
        return false, err
    end

    return true
end

local function reset_layout_virtual_effect_params(layout)
    if type(layout.virtual_device) ~= "table" then
        layout.virtual_device = normalize_virtual_device_config(nil)
    end

    local effect_id = layout.virtual_device.effect_id
    if type(effect_id) ~= "string" or effect_id == "" then
        layout.virtual_device.effect_id = nil
        layout.virtual_device.effect_params = {}
        return true
    end

    layout.virtual_device.effect_params = build_default_effect_params(effect_id)
    if not layout.registered then
        return true
    end

    local ok, err = pcall(ext.reset_scope_effect_params, layout_scope(layout))
    if not ok then
        return false, err
    end

    return true
end

local function apply_layout_virtual_state(layout)
    if type(layout) ~= "table" or not layout.registered then
        return true
    end

    local effect_id = layout.virtual_device and layout.virtual_device.effect_id or nil
    local effect_params = layout.virtual_device and layout.virtual_device.effect_params or {}
    local power_on = layout.virtual_device and layout.virtual_device.power_on ~= false

    local params = type(effect_params) == "table" and next(effect_params) and effect_params or nil
    local ok, err = pcall(ext.set_scope_effect, layout_scope(layout), effect_id, params)
    if not ok then
        return false, err
    end

    ok, err = pcall(ext.set_scope_power, layout_scope(layout), not power_on)
    if not ok then
        return false, err
    end

    return true
end

local function find_output_by_id(device, output_id)
    if type(device) ~= "table" or type(device.outputs) ~= "table" then
        return nil
    end

    local normalized_output_id = type(output_id) == "string" and output_id:lower() or nil
    local first_output = nil

    for _, output in ipairs(device.outputs) do
        if type(output) == "table" then
            first_output = first_output or output
            if output.id == output_id then
                return output
            end
            if normalized_output_id and type(output.id) == "string" and output.id:lower() == normalized_output_id then
                return output
            end
        end
    end

    if #device.outputs == 1 then
        return first_output
    end

    return nil
end

local function resolve_live_effect_id(mode_state)
    if type(mode_state) ~= "table" then
        return nil
    end

    for _, key in ipairs({ "effective_effect_id", "selected_effect_id", "effect_id" }) do
        local effect_id = mode_state[key]
        if type(effect_id) == "string" and effect_id ~= "" then
            return effect_id
        end
    end

    return nil
end

local function has_live_effect_state(mode_state)
    if type(mode_state) ~= "table" then
        return false
    end

    return resolve_live_effect_id(mode_state) ~= nil
        or mode_state.effective_params ~= nil
        or mode_state.selected_params ~= nil
        or mode_state.params ~= nil
end

local function resolve_live_effect_params(mode_state, effect_id, fallback)
    if type(effect_id) ~= "string" or effect_id == "" then
        return {}
    end

    if type(mode_state) == "table" then
        local params = mode_state.effective_params
        if params == nil then
            params = mode_state.selected_params
        end
        if params == nil then
            params = mode_state.params
        end

        if type(params) == "table" or params == json.null then
            return sanitize_virtual_device_params(params)
        end
    end

    if type(fallback) == "table" and fallback.effect_id == effect_id then
        return sanitize_virtual_device_params(fallback.effect_params)
    end

    return {}
end

local function resolve_live_power_on(power_state, fallback)
    if type(power_state) ~= "table" then
        return fallback ~= false
    end

    if power_state.effective_is_off ~= nil then
        return power_state.effective_is_off ~= true
    end

    if power_state.selected_is_off ~= nil then
        return power_state.selected_is_off ~= true
    end

    if power_state.is_off ~= nil then
        return power_state.is_off ~= true
    end

    return fallback ~= false
end

local function has_live_power_state(power_state)
    return type(power_state) == "table"
        and (
            power_state.effective_is_off ~= nil
            or power_state.selected_is_off ~= nil
            or power_state.is_off ~= nil
        )
end

local function device_has_live_effect_state(device)
    if type(device) ~= "table" then
        return false
    end

    if has_live_effect_state(device.mode) then
        return true
    end

    if type(device.outputs) ~= "table" then
        return false
    end

    for _, output in ipairs(device.outputs) do
        if type(output) == "table" and has_live_effect_state(output.mode) then
            return true
        end
    end

    return false
end

local function device_has_live_canvas_output_state(device)
    local output = find_output_by_id(device, CANVAS_OUTPUT_ID)
    if type(output) ~= "table" then
        return false
    end

    return has_live_effect_state(output.mode) or has_live_power_state(output.power)
end

local function resolve_live_canvas_device(devices, port)
    if type(port) ~= "string" or port == "" then
        return nil
    end

    local candidate = nil
    if type(devices) == "table" then
        for _, device in ipairs(devices) do
            if type(device) == "table" and device.port == port then
                candidate = device
                break
            end
        end
    end

    if candidate and device_has_live_canvas_output_state(candidate) then
        return candidate
    end

    local ok, detailed = pcall(ext.get_device_info, port)
    if ok and type(detailed) == "table" then
        return detailed
    end

    if candidate and device_has_live_effect_state(candidate) then
        return candidate
    end

    return candidate
end

local function resolve_live_canvas_output(devices, port)
    local device = resolve_live_canvas_device(devices, port)
    if type(device) ~= "table" then
        return nil, nil
    end

    return find_output_by_id(device, CANVAS_OUTPUT_ID), device
end

local function sync_canvas_virtual_device_states(devices)
    if type(devices) ~= "table" then
        return false
    end

    local changed = false

    for _, layout in ipairs(config and config.layouts or {}) do
        if layout.registered then
            local current = normalize_virtual_device_config(layout.virtual_device)
            local port = layout_port(layout.id)
            local live_output, live_device = resolve_live_canvas_output(devices, port)

            local next_state = current
            if live_output or live_device then
                local mode_state = type(live_output) == "table" and type(live_output.mode) == "table" and live_output.mode or nil
                if not has_live_effect_state(mode_state) and type(live_device) == "table" then
                    mode_state = type(live_device.mode) == "table" and live_device.mode or nil
                end

                local power_state = type(live_output) == "table" and type(live_output.power) == "table" and live_output.power or nil
                if not has_live_power_state(power_state) and type(live_device) == "table" then
                    power_state = type(live_device.power) == "table" and live_device.power or nil
                end

                local effect_id = resolve_live_effect_id(mode_state)

                next_state = {
                    power_on = resolve_live_power_on(power_state, current.power_on),
                    effect_id = effect_id,
                    effect_params = resolve_live_effect_params(mode_state, effect_id, current),
                }
            end

            if not plain_values_equal(current, next_state) then
                layout.virtual_device = next_state
                changed = true
            else
                layout.virtual_device = current
            end
        end
    end

    return changed
end

--- Mirror device nicknames back into registered layout names (device → layout).
local function sync_canvas_nicknames(devices)
    if type(devices) ~= "table" then return false end
    local changed = false
    for _, layout in ipairs(config and config.layouts or {}) do
        if layout.registered then
            local port = layout_port(layout.id)
            for _, device in ipairs(devices) do
                if device.port == port then
                    local name = sanitize_layout_name(device.nickname, layout.id)
                    if name ~= layout.name then
                        layout.name = name
                        changed = true
                    end
                    break
                end
            end
        end
    end
    return changed
end

local function sync_live_canvas_layout_state(devices)
    local current_devices = devices
    if type(current_devices) ~= "table" then
        local ok, queried_devices = pcall(ext.get_devices)
        if not ok or type(queried_devices) ~= "table" then
            return nil, false
        end
        current_devices = queried_devices
    end

    local names_changed = sync_canvas_nicknames(current_devices)
    local virtual_state_changed = sync_canvas_virtual_device_states(current_devices)
    return get_device_lookup(current_devices), names_changed or virtual_state_changed
end

--- Find a layout by id.  Returns the layout table and its index, or nil.
local function find_layout(layout_id)
    for i, layout in ipairs(config.layouts) do
        if layout.id == layout_id then
            return layout, i
        end
    end
    return nil
end

--- Save config to disk (fire-and-forget).
local function save_config()
    config = normalize_config(config, get_device_lookup())
    persist.save(config)
end

-- ── Per-layout routing helpers ──────────────────────────────────────

local function list_indices_from_set(indices_set)
    local indices = {}
    if type(indices_set) ~= "table" then
        return indices
    end

    for idx in pairs(indices_set) do
        indices[#indices + 1] = idx
    end
    table.sort(indices)
    return indices
end

local function sync_core_locks(desired_outputs)
    local next_state = {}

    for key, desired in pairs(desired_outputs) do
        local existing = core_locked_outputs[key]
        local desired_set = desired.indices_set or {}

        if existing then
            local to_unlock = {}
            for idx in pairs(existing.indices_set or {}) do
                if not desired_set[idx] then
                    to_unlock[#to_unlock + 1] = idx
                end
            end
            if #to_unlock > 0 then
                local ok, err = pcall(ext.unlock_leds, existing.port, existing.outputId, to_unlock)
                if not ok then
                    ext.log("warn: failed to unlock " .. key .. ": " .. tostring(err))
                end
            end

            local to_lock = {}
            for idx in pairs(desired_set) do
                if not (existing.indices_set and existing.indices_set[idx]) then
                    to_lock[#to_lock + 1] = idx
                end
            end
            if #to_lock > 0 then
                local ok, err = pcall(ext.lock_leds, desired.port, desired.outputId, to_lock)
                if not ok then
                    ext.log("warn: failed to lock " .. key .. ": " .. tostring(err))
                end
            end
        else
            local indices = list_indices_from_set(desired_set)
            if #indices > 0 then
                local ok, err = pcall(ext.lock_leds, desired.port, desired.outputId, indices)
                if not ok then
                    ext.log("warn: failed to lock " .. key .. ": " .. tostring(err))
                end
            end
        end

        next_state[key] = {
            port = desired.port,
            outputId = desired.outputId,
            indices_set = desired_set,
        }
    end

    for key, existing in pairs(core_locked_outputs) do
        if not next_state[key] then
            local indices = list_indices_from_set(existing.indices_set)
            if #indices > 0 then
                local ok, err = pcall(ext.unlock_leds, existing.port, existing.outputId, indices)
                if not ok then
                    ext.log("warn: failed to unlock " .. key .. ": " .. tostring(err))
                end
            end
        end
    end

    core_locked_outputs = next_state
end

local function rebuild_all_routing(device_lookup)
    local lookup = device_lookup or get_device_lookup()
    local desired_core_locks = {}   -- output_key → { port, outputId, indices_set }
    local occupied_by_output = {}   -- output_key → { actual_index → layout_id }

    routing_tables = {}
    placement_led_status = {}

    for _, layout in ipairs(config.layouts) do
        local status = {}

        if layout.registered then
            local runtime_placements = {}
            for _, placement in ipairs(layout.placements or {}) do
                local runtime = runtime_placement(placement, lookup)
                if runtime and #runtime.actualIndices > 0 then
                    runtime_placements[#runtime_placements + 1] = runtime
                end
            end

            local cw = layout.canvas and layout.canvas.width or DEFAULT_GRID_W
            local ch = layout.canvas and layout.canvas.height or DEFAULT_GRID_H
            local rt = routing.build(runtime_placements, cw, ch)

            -- Resolve conflicts: earlier layouts in the array take priority.
            for _, runtime in ipairs(runtime_placements) do
                local output_key = placement_lock_key(runtime)
                local routing_key = placement_routing_key(runtime)
                local entry = rt[routing_key]
                if entry then
                    local occupied = occupied_by_output[output_key]
                    if not occupied then
                        occupied = {}
                        occupied_by_output[output_key] = occupied
                    end

                    local desired = desired_core_locks[output_key]
                    if not desired then
                        desired = { port = runtime.port, outputId = runtime.outputId, indices_set = {} }
                        desired_core_locks[output_key] = desired
                    end

                    local available_leds = {}
                    local blocked_indices = {}
                    for _, led in ipairs(entry.leds) do
                        local owner = occupied[led.target_idx]
                        if not owner or owner == layout.id then
                            occupied[led.target_idx] = layout.id
                            desired.indices_set[led.target_idx] = true
                            available_leds[#available_leds + 1] = led
                        else
                            blocked_indices[#blocked_indices + 1] = led.local_idx
                        end
                    end

                    entry.leds = available_leds
                    status[runtime.id] = {
                        blockedLedIndices = blocked_indices,
                        blockedLedCount = #blocked_indices,
                        availableLedCount = #available_leds,
                    }
                end
            end

            routing_tables[layout.id] = rt
        else
            -- Non-registered: compute blocked status without claiming ownership.
            for _, placement in ipairs(layout.placements or {}) do
                if type(placement.id) == "string" then
                    local runtime = runtime_placement(placement, lookup)
                    if runtime then
                        local occupied = occupied_by_output[placement_lock_key(runtime)] or {}
                        local blocked_indices = {}
                        local available_count = 0
                        for idx, local_idx in ipairs(runtime.localIndices) do
                            local actual_idx = runtime.actualIndices[idx]
                            if occupied[actual_idx] and occupied[actual_idx] ~= layout.id then
                                blocked_indices[#blocked_indices + 1] = local_idx
                            else
                                available_count = available_count + 1
                            end
                        end
                        status[placement.id] = {
                            blockedLedIndices = blocked_indices,
                            blockedLedCount = #blocked_indices,
                            availableLedCount = available_count,
                        }
                    end
                end
            end
        end

        placement_led_status[layout.id] = status
    end

    sync_core_locks(desired_core_locks)
end

-- ── Canvas device lifecycle (per-layout) ────────────────────────────

--- Move a layout to just after the last registered layout in the array.
--- Establishes priority: earlier-registered layouts take precedence.
local function move_layout_after_registered(layout)
    local _, idx = find_layout(layout.id)
    if not idx then return end
    table.remove(config.layouts, idx)

    local insert_pos = 0
    for i, l in ipairs(config.layouts) do
        if l.registered then
            insert_pos = i
        end
    end
    table.insert(config.layouts, insert_pos + 1, layout)
end

--- Register a layout's canvas device with Core (does not rebuild routing).
local function do_register_canvas(layout)
    layout.name = sanitize_layout_name(layout.name, layout.id)
    local cw = sanitize_canvas_side(layout.canvas and layout.canvas.width, DEFAULT_GRID_W)
    local ch = sanitize_canvas_side(layout.canvas and layout.canvas.height, DEFAULT_GRID_H)
    local total_leds = cw * ch
    local port = layout_port(layout.id)

    local ok, err = pcall(ext.register_device, {
        controller_port = port,
        device_path = port,
        controller_id = "extension.led_canvas.canvas",
        nickname    = layout.name,
        manufacturer = CANVAS_MANUFACTURER,
        model       = "Virtual Canvas",
        description = string.format("Virtual Canvas %dx%d", cw, ch),
        serial_id   = layout.id,
        device_type = "virtual",
        outputs = {
            {
                id          = CANVAS_OUTPUT_ID,
                name        = "Canvas",
                output_type = "matrix",
                leds_count  = total_leds,
                matrix      = {
                    width  = cw,
                    height = ch,
                    map    = identity_matrix_map(cw, ch),
                },
            },
        },
    })

    if ok then
        layout.registered = true
        move_layout_after_registered(layout)
        local applied, apply_err = apply_layout_virtual_state(layout)
        if not applied then
            ext.warn("failed to apply virtual-device state for layout " .. tostring(layout.id) .. ": " .. tostring(apply_err))
        end
        ext.log(string.format("Canvas registered: %s (%s, %dx%d)", layout.name, port, cw, ch))
    else
        ext.log("error: failed to register canvas for layout " .. layout.id .. ": " .. tostring(err))
    end

    return ok
end

local function register_canvas_device(layout)
    if do_register_canvas(layout) then
        rebuild_all_routing()
    end
end

--- Unregister a layout's canvas device from Core (does not rebuild routing).
local function do_unregister_canvas(layout)
    if not layout.registered then return end
    pcall(ext.remove_extension_device, layout_port(layout.id))
    layout.registered = false
    routing_tables[layout.id] = nil
    ext.log("Canvas unregistered: " .. (layout.name or layout.id))
end

local function unregister_canvas_device(layout)
    do_unregister_canvas(layout)
    rebuild_all_routing()
end

local function sync_canvas_size(layout, width, height)
    local cw = sanitize_canvas_side(width, layout.canvas and layout.canvas.width or DEFAULT_GRID_W)
    local ch = sanitize_canvas_side(height, layout.canvas and layout.canvas.height or DEFAULT_GRID_H)

    if not layout.canvas then
        layout.canvas = { width = cw, height = ch, x = 0, y = 0 }
    end

    local changed = cw ~= layout.canvas.width or ch ~= layout.canvas.height
    layout.canvas.width = cw
    layout.canvas.height = ch

    if changed and layout.registered then
        local total_leds = cw * ch
        local port = layout_port(layout.id)
        local ok, err = pcall(ext.update_output, port, CANVAS_OUTPUT_ID, {
            leds_count = total_leds,
            matrix = {
                width  = cw,
                height = ch,
                map    = identity_matrix_map(cw, ch),
            },
        })
        if ok then
            ext.log(string.format("Canvas resized: %s (%dx%d)", layout.name, cw, ch))
            rebuild_all_routing()
            return true
        else
            ext.log("error: failed to resize canvas: " .. tostring(err))
        end
    end

    return false
end

-- ── Emit helpers ────────────────────────────────────────────────────

--- Build a serializable layout summary for the frontend.
local function layout_summary(layout, device_lookup)
    local lookup = device_lookup or get_device_lookup()
    local placements = {}
    local status = placement_led_status[layout.id] or {}
    local raw_virtual_device = nil
    local raw_virtual_output = nil

    if layout.registered then
        raw_virtual_output, raw_virtual_device = resolve_live_canvas_output(nil, layout_port(layout.id))
    end

    for _, placement in ipairs(layout.placements or {}) do
        local placement_status = status[placement.id] or {}
        local runtime = runtime_placement(placement, lookup)
        local stale = is_placement_stale(
            placement.snapshot, lookup,
            placement.deviceId, placement.outputId, placement.segmentId
        )
        local summary = {
            id = placement.id,
            deviceId = placement.deviceId,
            name = placement.name,
            outputId = placement.outputId,
            segmentId = placement.segmentId,
            x = placement.x,
            y = placement.y,
            width = placement.width,
            height = placement.height,
            rotation = normalize_rotation(placement.rotation),
            ledsCount = runtime and runtime.ledsCount or placement.ledsCount,
            matrix = placement.matrix,
            brightness = placement.brightness or 100,
            snapshot = placement.snapshot,
            stale = stale,
            blockedLedIndices = placement_status.blockedLedIndices or {},
            blockedLedCount = placement_status.blockedLedCount or 0,
            availableLedCount = placement_status.availableLedCount or (runtime and runtime.ledsCount) or placement.ledsCount or 0,
        }
        summary.port = runtime and runtime.port or resolve_runtime_port(lookup, placement)
        placements[#placements + 1] = summary
    end

    return {
        id          = layout.id,
        name        = layout.name,
        registered  = layout.registered or false,
        canvas      = layout.canvas,
        snap_to_grid = layout.snap_to_grid or false,
        placements  = placements,
        virtual_device = {
            power_on = layout.virtual_device and layout.virtual_device.power_on ~= false,
            effect_id = layout.virtual_device and layout.virtual_device.effect_id or nil,
            effect_params = clone_plain_value(layout.virtual_device and layout.virtual_device.effect_params or {}),
            raw_device = clone_plain_value(raw_virtual_device),
            raw_output = clone_plain_value(raw_virtual_output),
        },
    }
end

local function emit_effect_catalog()
    ext.page_emit({
        type = "effects_catalog",
        effects = build_effect_catalog(),
    })
end

--- Emit full state to the page.
local function emit_full_state(device_lookup)
    local summaries = {}
    for _, layout in ipairs(config.layouts) do
        summaries[#summaries + 1] = layout_summary(layout, device_lookup)
    end

    ext.page_emit({
        type             = "full_state",
        active_layout_id = config.active_layout_id,
        layouts          = summaries,
    })
end

--- Emit status for a single layout.
local function emit_layout_status(layout, device_lookup)
    ext.page_emit({
        type   = "layout_status",
        layout = layout_summary(layout, device_lookup),
    })
end

-- ── Extension Callbacks ─────────────────────────────────────────────

function P.on_start()
    ext.log("Device Viewer extension started")

    -- Load persisted config.
    config = normalize_config(persist.load(), get_device_lookup())

    -- Re-register previously registered layouts (in saved order).
    -- Batch all registrations, then rebuild routing once.
    local to_register = {}
    for _, layout in ipairs(config.layouts) do
        if layout.registered then
            to_register[#to_register + 1] = layout
            layout.registered = false
        end
    end
    for _, layout in ipairs(to_register) do
        do_register_canvas(layout)
    end

    local startup_lookup = sync_live_canvas_layout_state()
    rebuild_all_routing(startup_lookup)
    save_config()
end

function P.on_devices_changed(devices)
    local lookup = get_device_lookup(devices)
    local normalized = normalize_config(config, lookup)
    config = normalized
    sync_canvas_nicknames(devices)
    sync_canvas_virtual_device_states(devices)
    rebuild_all_routing(lookup)
    save_config()
    ext.page_emit({ type = "devices", data = filter_devices_for_page(devices) })
    emit_full_state(lookup)
end

function P.on_page_message(msg)
    if not msg or not msg.type then return end

    -- ── Device list ──
    if msg.type == "get_devices" then
        local devices = ext.get_devices()
        ext.page_emit({ type = "devices", data = filter_devices_for_page(devices) })

    -- ── Effects catalog ──
    elseif msg.type == "get_effects_catalog" then
        emit_effect_catalog()

    -- ── Full state request ──
    elseif msg.type == "get_full_state" then
        local lookup, changed = sync_live_canvas_layout_state()
        if changed then
            save_config()
        end
        emit_full_state(lookup)

    -- ── Switch active layout ──
    elseif msg.type == "switch_layout" then
        local layout = find_layout(msg.layout_id)
        if layout then
            config.active_layout_id = msg.layout_id
            save_config()
            emit_full_state()
        end

    -- ── Create new layout ──
    elseif msg.type == "create_layout" then
        local new_id = generate_layout_id(collect_layout_ids(config.layouts))
        local new_layout = {
            id          = new_id,
            name        = sanitize_layout_name(msg.name, "Layout " .. tostring(#config.layouts + 1)),
            canvas      = { width = DEFAULT_GRID_W, height = DEFAULT_GRID_H, x = 0, y = 0 },
            placements  = {},
            registered  = false,
            snap_to_grid = false,
        }
        config.layouts[#config.layouts + 1] = new_layout
        config.active_layout_id = new_id
        save_config()
        emit_full_state()

    -- ── Delete layout ──
    elseif msg.type == "delete_layout" then
        local layout, idx = find_layout(msg.layout_id)
        if layout and #config.layouts > 1 then
            -- Unregister if active
            if layout.registered then
                unregister_canvas_device(layout)
            end
            table.remove(config.layouts, idx)
            -- If deleted the active layout, switch to first
            if config.active_layout_id == msg.layout_id then
                config.active_layout_id = config.layouts[1].id
            end
            save_config()
            emit_full_state()
        end

    -- ── Rename layout ──
    elseif msg.type == "rename_layout" then
        local layout = find_layout(msg.layout_id)
        if layout and msg.name then
            local previous_name = layout.name
            local next_name = sanitize_layout_name(msg.name, previous_name or layout.id)
            if next_name == previous_name then
                return
            end

            layout.name = next_name
            if layout.registered then
                local ok, err = pcall(ext.set_device_nickname, layout_port(layout.id), layout.name)
                if not ok then
                    layout.name = previous_name
                    ext.warn("set_device_nickname failed: " .. tostring(err))
                    emit_layout_status(layout)
                    return
                end
            end
            save_config()
            emit_layout_status(layout)
        end

    -- ── Register canvas for a layout ──
    elseif msg.type == "register_canvas" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            if msg.width or msg.height then
                sync_canvas_size(layout, msg.width, msg.height)
            end
            if not layout.registered then
                register_canvas_device(layout)
            end
            save_config()
            emit_full_state()
        end

    -- ── Unregister canvas for a layout ──
    elseif msg.type == "unregister_canvas" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            unregister_canvas_device(layout)
            save_config()
            emit_full_state()
        end

    -- ── Update placements for a layout ──
    elseif msg.type == "update_placements" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            layout.placements = normalize_placements(msg.data, get_device_lookup())
            local routing_rebuilt = false
            if msg.canvas then
                routing_rebuilt = sync_canvas_size(layout, msg.canvas.width, msg.canvas.height)
            end
            if not routing_rebuilt then
                rebuild_all_routing()
            end
            save_config()
            emit_full_state()
        end

    -- ── Update brightness for a single placement ──
    elseif msg.type == "update_placement_brightness" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout and msg.placement_id then
            local clamped = sanitize_brightness(msg.brightness)
            for _, p in ipairs(layout.placements or {}) do
                if p.id == msg.placement_id then
                    p.brightness = clamped
                    break
                end
            end
            rebuild_all_routing()
            save_config()
        end

    -- ── Update snap_to_grid for a layout ──
    elseif msg.type == "update_snap" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            layout.snap_to_grid = msg.snap_to_grid or false
            save_config()
            emit_layout_status(layout)
        end

    -- ── Virtual-device power ──
    elseif msg.type == "set_layout_virtual_power" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            local previous = clone_plain_value(layout.virtual_device)
            local ok, err = set_layout_virtual_power(layout, msg.power_on)
            if not ok then
                layout.virtual_device = previous
                ext.warn("set_scope_power failed for layout " .. tostring(layout.id) .. ": " .. tostring(err))
                emit_layout_status(layout)
                return
            end
            save_config()
            emit_layout_status(layout)
        end

    -- ── Virtual-device effect ──
    elseif msg.type == "set_layout_virtual_effect" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            local previous = clone_plain_value(layout.virtual_device)
            local ok, err = set_layout_virtual_effect(layout, msg.effect_id)
            if not ok then
                layout.virtual_device = previous
                ext.warn("set_scope_effect failed for layout " .. tostring(layout.id) .. ": " .. tostring(err))
                emit_layout_status(layout)
                return
            end
            save_config()
            emit_layout_status(layout)
        end

    -- ── Virtual-device effect params ──
    elseif msg.type == "update_layout_virtual_effect_params" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            local previous = clone_plain_value(layout.virtual_device)
            local ok, err = update_layout_virtual_effect_params(layout, msg.params)
            if not ok then
                layout.virtual_device = previous
                ext.warn("update_scope_effect_params failed for layout " .. tostring(layout.id) .. ": " .. tostring(err))
                emit_layout_status(layout)
                return
            end
            save_config()
            emit_layout_status(layout)
        end

    -- ── Reset virtual-device effect params ──
    elseif msg.type == "reset_layout_virtual_effect_params" then
        local lid = msg.layout_id or config.active_layout_id
        local layout = find_layout(lid)
        if layout then
            local previous = clone_plain_value(layout.virtual_device)
            local ok, err = reset_layout_virtual_effect_params(layout)
            if not ok then
                layout.virtual_device = previous
                ext.warn("reset_scope_effect_params failed for layout " .. tostring(layout.id) .. ": " .. tostring(err))
                emit_layout_status(layout)
                return
            end
            save_config()
            emit_layout_status(layout)
        end

    -- ── Legacy: get_canvas_status → emit full state ──
    elseif msg.type == "get_canvas_status" then
        local lookup, changed = sync_live_canvas_layout_state()
        if changed then
            save_config()
        end
        emit_full_state(lookup)
    end
end

function P.on_device_frame(port, outputs)
    -- Check if this port belongs to any layout.
    -- Port format: ext:led_canvas:canvas:<layout_id>
    local prefix_len = #CANVAS_PORT_PREFIX + 1  -- +1 for the ':'
    if port:sub(1, prefix_len) ~= CANVAS_PORT_PREFIX .. ":" then return end
    local layout_id = port:sub(prefix_len + 1)

    local layout = find_layout(layout_id)
    if not layout or not layout.registered then return end

    local rt = routing_tables[layout_id]
    if not rt then return end

    local canvas_output = outputs[CANVAS_OUTPUT_ID]
    if not canvas_output then return end

    local routed = routing.route(canvas_output, rt)

    for _, entry in pairs(routed) do
        local ok, err = pcall(ext.set_leds, entry.port, entry.outputId, entry.colors)
        if not ok then
            ext.log("warn: set_leds failed for " .. entry.port .. "::" .. entry.outputId .. ": " .. tostring(err))
        end
    end
end

function P.on_stop()
    -- Unregister all canvas devices and save state.
    -- Use do_unregister_canvas to avoid redundant rebuild_all_routing per layout.
    for _, layout in ipairs(config.layouts) do
        if layout.registered then
            do_unregister_canvas(layout)
            -- Keep registered=true in config so it auto-restores next time.
            layout.registered = true
        end
    end
    save_config()
    ext.log("Device Viewer extension stopped")
end

return P
