--- Persistent configuration store for led_canvas.
--
-- Layout payload is stored as one JSON file per layout. A tiny meta file keeps
-- the layout order and active layout id so large placement payloads do not
-- accumulate into a single ever-growing config blob.

local json = require("lib.json")

local M = {}

local META_FILE = "meta.json"
local LEGACY_CONFIG_FILE = "config.json"
local CONFIG_VERSION = 2

local function default_config()
    return {
        version          = CONFIG_VERSION,
        active_layout_id = "default",
        layouts          = {
            {
                id           = "default",
                name         = "Default",
                registered   = false,
                canvas       = { width = 64, height = 64, x = 0, y = 0 },
                placements   = {},
                snap_to_grid = false,
            },
        },
    }
end

local function meta_path()
    return ext.data_dir .. "/" .. META_FILE
end

local function legacy_config_path()
    return ext.data_dir .. "/" .. LEGACY_CONFIG_FILE
end

local function layout_path(layout_id)
    return ext.data_dir .. "/" .. tostring(layout_id) .. ".json"
end

local function read_json_file(path)
    local f, err = io.open(path, "r")
    if not f then return nil, err end
    local raw = f:read("*a")
    f:close()
    if not raw or raw == "" then return nil, "empty file" end
    local ok, data = pcall(json.decode, raw)
    if not ok or type(data) ~= "table" then return nil, "invalid json" end
    return data
end

local function write_json_file(path, data)
    local tmp  = path .. ".tmp"
    local ok_enc, raw = pcall(json.encode, data)
    if not ok_enc then
        ext.error("store: failed to encode json for " .. tostring(path) .. ": " .. tostring(raw))
        return false
    end
    local f, err = io.open(tmp, "w")
    if not f then
        ext.error("store: failed to open tmp file " .. tostring(tmp) .. ": " .. tostring(err))
        return false
    end
    f:write(raw)
    f:close()
    os.remove(path)
    local ok_rename, rerr = os.rename(tmp, path)
    if not ok_rename then
        ext.error("store: failed to rename tmp -> target: " .. tostring(rerr))
        return false
    end
    return true
end

--- Read persisted layouts; fall back to the legacy monolithic config if needed.
function M.load()
    local meta, meta_err = read_json_file(meta_path())
    if type(meta) ~= "table" then
        local legacy, legacy_err = read_json_file(legacy_config_path())
        if type(legacy) == "table" then
            if not legacy.version then legacy.version = 1 end
            if type(legacy.layouts) ~= "table" then legacy.layouts = {} end
            if not legacy.active_layout_id then
                legacy.active_layout_id = legacy.layouts[1] and legacy.layouts[1].id or "default"
            end
            ext.log("store: loaded legacy layout config from config.json")
            return legacy
        end

        ext.log(
            "store: no persisted layout meta, using defaults (meta="
            .. tostring(meta_err)
            .. ", legacy="
            .. tostring(legacy_err)
            .. ")"
        )
        return default_config()
    end

    local ids = type(meta.layout_ids) == "table" and meta.layout_ids or {}
    local layouts = {}

    for _, layout_id in ipairs(ids) do
        local layout, err = read_json_file(layout_path(layout_id))
        if type(layout) == "table" then
            layouts[#layouts + 1] = layout
        else
            ext.warn("store: failed to load layout " .. tostring(layout_id) .. ": " .. tostring(err))
        end
    end

    if #layouts == 0 then
        return default_config()
    end

    return {
        version = meta.version or CONFIG_VERSION,
        active_layout_id = meta.active_layout_id or layouts[1].id,
        layouts = layouts,
    }
end

--- Write the config table to disk (atomic-ish: write tmp, rename).
function M.save(config)
    local previous_meta = read_json_file(meta_path())
    local stale_ids = {}

    if type(previous_meta) == "table" and type(previous_meta.layout_ids) == "table" then
        for _, layout_id in ipairs(previous_meta.layout_ids) do
            stale_ids[layout_id] = true
        end
    end

    local next_ids = {}
    for _, layout in ipairs(config.layouts or {}) do
        local layout_id = tostring(layout.id or "")
        if layout_id ~= "" then
            if not write_json_file(layout_path(layout_id), layout) then
                return false
            end
            next_ids[#next_ids + 1] = layout_id
            stale_ids[layout_id] = nil
        end
    end

    for layout_id in pairs(stale_ids) do
        os.remove(layout_path(layout_id))
    end

    if not write_json_file(meta_path(), {
        version = CONFIG_VERSION,
        active_layout_id = config.active_layout_id,
        layout_ids = next_ids,
    }) then
        return false
    end

    os.remove(legacy_config_path())
    return true
end

--- Find a layout by id in the config; return the layout table and its index, or nil.
function M.find_layout(config, layout_id)
    for i, layout in ipairs(config.layouts) do
        if layout.id == layout_id then
            return layout, i
        end
    end
    return nil, nil
end

--- Get the currently active layout (or create a default one if missing).
function M.active_layout(config)
    local layout = M.find_layout(config, config.active_layout_id)
    if layout then return layout end
    -- Fallback: first layout, or create default
    if #config.layouts > 0 then
        config.active_layout_id = config.layouts[1].id
        return config.layouts[1]
    end
    local def = default_config().layouts[1]
    config.layouts[#config.layouts + 1] = def
    config.active_layout_id = def.id
    return def
end

return M
