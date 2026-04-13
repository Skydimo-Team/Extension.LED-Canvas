--- Canvas-to-device routing engine.
--
-- Builds a pre-computed routing table that maps each physical LED to the
-- canvas cells it overlaps, weighted by fractional area coverage.
-- On each canvas frame, the table is walked and colours are mixed with
-- area-weighted averaging.
--
-- Usage from init.lua:
--   local routing = require("lib.routing")
--   local table   = routing.build(placements, GRID_W, GRID_H)
--   local colors  = routing.route(canvas_colors, table)

local M = {}

local floor = math.floor
local ceil  = math.ceil
local min   = math.min
local max   = math.max
local sqrt  = math.sqrt
local abs   = math.abs
local sin   = math.sin
local cos   = math.cos
local rad   = math.rad
local type  = type
local tonumber = tonumber
local EPS   = 1e-9

--- Compute fractional overlap area between two axis-aligned rectangles.
-- Returns 0 when the rectangles do not overlap.
local function overlap_area(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)
    local ox = max(0, min(ax2, bx2) - max(ax1, bx1))
    local oy = max(0, min(ay2, by2) - max(ay1, by1))
    return ox * oy
end

--- Rotate a point (px, py) around center (cx, cy) by angle_deg degrees (clockwise).
local function rotate_point(px, py, cx, cy, cos_a, sin_a)
    local dx = px - cx
    local dy = py - cy
    return cx + dx * cos_a - dy * sin_a,
           cy + dx * sin_a + dy * cos_a
end

--- Compute the axis-aligned bounding box of a rotated rectangle.
-- Takes the four corners of an unrotated rect (x1,y1)-(x2,y2), rotates
-- them around (cx,cy) and returns the enclosing AABB.
local function rotated_rect_aabb(x1, y1, x2, y2, cx, cy, cos_a, sin_a)
    local ax, ay = rotate_point(x1, y1, cx, cy, cos_a, sin_a)
    local bx, by = rotate_point(x2, y1, cx, cy, cos_a, sin_a)
    local ccx, ccy = rotate_point(x2, y2, cx, cy, cos_a, sin_a)
    local dx, dy = rotate_point(x1, y2, cx, cy, cos_a, sin_a)

    local min_x = min(ax, bx, ccx, dx)
    local min_y = min(ay, by, ccy, dy)
    local max_x = max(ax, bx, ccx, dx)
    local max_y = max(ay, by, ccy, dy)

    return min_x, min_y, max_x, max_y
end

local function polygon_area(points)
    local count = #points
    if count < 3 then
        return 0
    end

    local area = 0
    local prev = points[count]
    for i = 1, count do
        local curr = points[i]
        area = area + (prev.x * curr.y) - (curr.x * prev.y)
        prev = curr
    end

    return abs(area) * 0.5
end

local function clip_polygon_left(points, left)
    local result = {}
    local prev = points[#points]
    if not prev then
        return result
    end

    local prev_inside = prev.x >= left - EPS
    for i = 1, #points do
        local curr = points[i]
        local curr_inside = curr.x >= left - EPS

        if prev_inside ~= curr_inside then
            local dx = curr.x - prev.x
            if abs(dx) > EPS then
                local t = (left - prev.x) / dx
                result[#result + 1] = {
                    x = left,
                    y = prev.y + (curr.y - prev.y) * t,
                }
            end
        end

        if curr_inside then
            result[#result + 1] = { x = curr.x, y = curr.y }
        end

        prev = curr
        prev_inside = curr_inside
    end

    return result
end

local function clip_polygon_right(points, right)
    local result = {}
    local prev = points[#points]
    if not prev then
        return result
    end

    local prev_inside = prev.x <= right + EPS
    for i = 1, #points do
        local curr = points[i]
        local curr_inside = curr.x <= right + EPS

        if prev_inside ~= curr_inside then
            local dx = curr.x - prev.x
            if abs(dx) > EPS then
                local t = (right - prev.x) / dx
                result[#result + 1] = {
                    x = right,
                    y = prev.y + (curr.y - prev.y) * t,
                }
            end
        end

        if curr_inside then
            result[#result + 1] = { x = curr.x, y = curr.y }
        end

        prev = curr
        prev_inside = curr_inside
    end

    return result
end

local function clip_polygon_top(points, top)
    local result = {}
    local prev = points[#points]
    if not prev then
        return result
    end

    local prev_inside = prev.y >= top - EPS
    for i = 1, #points do
        local curr = points[i]
        local curr_inside = curr.y >= top - EPS

        if prev_inside ~= curr_inside then
            local dy = curr.y - prev.y
            if abs(dy) > EPS then
                local t = (top - prev.y) / dy
                result[#result + 1] = {
                    x = prev.x + (curr.x - prev.x) * t,
                    y = top,
                }
            end
        end

        if curr_inside then
            result[#result + 1] = { x = curr.x, y = curr.y }
        end

        prev = curr
        prev_inside = curr_inside
    end

    return result
end

local function clip_polygon_bottom(points, bottom)
    local result = {}
    local prev = points[#points]
    if not prev then
        return result
    end

    local prev_inside = prev.y <= bottom + EPS
    for i = 1, #points do
        local curr = points[i]
        local curr_inside = curr.y <= bottom + EPS

        if prev_inside ~= curr_inside then
            local dy = curr.y - prev.y
            if abs(dy) > EPS then
                local t = (bottom - prev.y) / dy
                result[#result + 1] = {
                    x = prev.x + (curr.x - prev.x) * t,
                    y = bottom,
                }
            end
        end

        if curr_inside then
            result[#result + 1] = { x = curr.x, y = curr.y }
        end

        prev = curr
        prev_inside = curr_inside
    end

    return result
end

local function polygon_rect_overlap_area(points, x1, y1, x2, y2)
    local clipped = clip_polygon_left(points, x1)
    if #clipped == 0 then return 0 end
    clipped = clip_polygon_right(clipped, x2)
    if #clipped == 0 then return 0 end
    clipped = clip_polygon_top(clipped, y1)
    if #clipped == 0 then return 0 end
    clipped = clip_polygon_bottom(clipped, y2)
    if #clipped == 0 then return 0 end
    return polygon_area(clipped)
end

--- Determine the LED grid dimensions (cols, rows) for a placed device.
--
-- If the device has a matrix with explicit width/height we use those.
-- Otherwise we derive a nearly-square auto-grid from `leds_count`:
--   cols = ceil(sqrt(N)), rows = ceil(N / cols)
local function led_grid_dims(p)
    if p.matrix and p.matrix.width and p.matrix.width > 0
       and p.matrix.height and p.matrix.height > 0 then
        return p.matrix.width, p.matrix.height
    end
    local n = p.ledsCount or 0
    if n <= 0 then return 1, 1 end
    return n, 1
end

--- Build LED world rectangles indexed by LED id (0-based + 1 for Lua array).
-- Uses matrix.map when available so sparse/non-linear matrix layouts keep their
-- actual LED positions instead of assuming row-major LED ordering.
--
-- When rotation ~= 0, each LED rect is stored as a rotated quadrilateral plus
-- an axis-aligned bounding box used to coarse-filter candidate canvas cells.
local function build_led_rects(p, cols, rows, total_leds)
    local dev_w = (type(p.width) == "number" and p.width > 0) and p.width or cols
    local dev_h = (type(p.height) == "number" and p.height > 0) and p.height or rows
    local origin_x = (type(p.x) == "number") and p.x or 0
    local origin_y = (type(p.y) == "number") and p.y or 0
    local rotation = tonumber(p.rotation) or 0
    rotation = rotation % 360
    if rotation < 0 then
        rotation = rotation + 360
    end

    local led_w = dev_w / cols
    local led_h = dev_h / rows

    -- Precompute rotation if needed.
    local has_rotation = abs(rotation) > EPS
    local cos_a, sin_a, center_x, center_y
    if has_rotation then
        local angle_rad = rad(rotation)
        cos_a = cos(angle_rad)
        sin_a = sin(angle_rad)
        center_x = origin_x + dev_w / 2
        center_y = origin_y + dev_h / 2
    end

    local rects = {}
    local matrix = p.matrix
    local map = matrix and matrix.map

    local function make_led_geometry(x1, y1, x2, y2)
        if not has_rotation then
            return {
                x1 = x1,
                y1 = y1,
                x2 = x2,
                y2 = y2,
                bounds = {
                    x1 = x1,
                    y1 = y1,
                    x2 = x2,
                    y2 = y2,
                },
            }
        end

        local ax, ay = rotate_point(x1, y1, center_x, center_y, cos_a, sin_a)
        local bx, by = rotate_point(x2, y1, center_x, center_y, cos_a, sin_a)
        local cx, cy = rotate_point(x2, y2, center_x, center_y, cos_a, sin_a)
        local dx, dy = rotate_point(x1, y2, center_x, center_y, cos_a, sin_a)
        local min_x, min_y, max_x, max_y = rotated_rect_aabb(x1, y1, x2, y2, center_x, center_y, cos_a, sin_a)

        return {
            points = {
                { x = ax, y = ay },
                { x = bx, y = by },
                { x = cx, y = cy },
                { x = dx, y = dy },
            },
            bounds = {
                x1 = min_x,
                y1 = min_y,
                x2 = max_x,
                y2 = max_y,
            },
        }
    end

    if matrix and map and type(map) == "table" then
        local cell_count = cols * rows
        for cell = 0, cell_count - 1 do
            local mapped = map[cell + 1]
            if type(mapped) == "number" and mapped >= 0 then
                local led_idx = floor(mapped)
                if mapped == led_idx and led_idx < total_leds and not rects[led_idx + 1] then
                    local col = cell % cols
                    local row = floor(cell / cols)
                    local lx1 = origin_x + col * led_w
                    local ly1 = origin_y + row * led_h
                    local lx2 = origin_x + (col + 1) * led_w
                    local ly2 = origin_y + (row + 1) * led_h
                    rects[led_idx + 1] = make_led_geometry(lx1, ly1, lx2, ly2)
                end
            end
        end
    end

    -- Fallback for missing/unmapped LEDs to keep output length stable.
    for i = 0, total_leds - 1 do
        if not rects[i + 1] then
            local col = i % cols
            local row = floor(i / cols)
            local lx1 = origin_x + col * led_w
            local ly1 = origin_y + row * led_h
            local lx2 = origin_x + (col + 1) * led_w
            local ly2 = origin_y + (row + 1) * led_h
            rects[i + 1] = make_led_geometry(lx1, ly1, lx2, ly2)
        end
    end

    return rects
end

--- Build a routing table from the current canvas placements.
--
-- @param placements  Array of placement tables, each containing:
--   { port, outputId, segmentId?, x, y, width, height, rotation?, ledsCount, matrix,
--     localIndices?, actualIndices? }
-- @param grid_width  Canvas grid width (64 by default).
-- @param grid_height Canvas grid height (defaults to grid_width).
--
-- @return table  Keyed by `"port::outputId"` (or `"port::outputId::segmentId"`),
--   value = array of LED entries:
--     { overlaps = { { idx=canvas_flat_index, w=weight }, ... } }
--   `idx` is 0-based (row * grid_width + col), `w` is normalised ∈ (0,1].
function M.build(placements, grid_width, grid_height)
    grid_width = tonumber(grid_width) or 64
    grid_height = tonumber(grid_height) or grid_width
    grid_width = max(1, floor(grid_width + 0.5))
    grid_height = max(1, floor(grid_height + 0.5))
    local rt = {}

    for _, p in ipairs(placements) do
        local key = p.port .. "::" .. p.outputId
        if p.segmentId and p.segmentId ~= "" then
            key = key .. "::" .. p.segmentId
        end

        local cols, rows = led_grid_dims(p)
        local total_leds = p.ledsCount or (cols * rows)
        local led_rects = build_led_rects(p, cols, rows, total_leds)

        local actual_indices = type(p.actualIndices) == "table" and p.actualIndices or nil
        local local_indices = type(p.localIndices) == "table" and p.localIndices or nil
        if not local_indices then
            local_indices = {}
            for i = 0, total_leds - 1 do
                local_indices[#local_indices + 1] = i
            end
        end

        local actual_index_by_local = {}
        for idx, local_idx in ipairs(local_indices) do
            actual_index_by_local[local_idx] = actual_indices and actual_indices[idx] or local_idx
        end

        local entries = {}
        for _, local_idx in ipairs(local_indices) do
            local rect = led_rects[local_idx + 1]
            if not rect then
                goto continue
            end
            local bounds = rect.bounds or rect
            local lx1, ly1 = bounds.x1, bounds.y1
            local lx2, ly2 = bounds.x2, bounds.y2

            -- Canvas cell range that may overlap (cells are unit squares at integer coords)
            local cx_min = max(0, floor(lx1))
            local cy_min = max(0, floor(ly1))
            local cx_max = min(grid_width - 1, floor(lx2 - EPS))
            local cy_max = min(grid_height - 1, floor(ly2 - EPS))
            if cx_min > cx_max or cy_min > cy_max then
                goto continue
            end

            local overlaps = {}
            local total_w = 0

            for cy = cy_min, cy_max do
                for cx = cx_min, cx_max do
                    local area
                    if rect.points then
                        area = polygon_rect_overlap_area(rect.points, cx, cy, cx + 1, cy + 1)
                    else
                        area = overlap_area(rect.x1, rect.y1, rect.x2, rect.y2, cx, cy, cx + 1, cy + 1)
                    end
                    if area > EPS then
                        overlaps[#overlaps + 1] = { idx = cy * grid_width + cx, w = area }
                        total_w = total_w + area
                    end
                end
            end

            -- Normalise weights so they sum to 1.
            if total_w > 0 then
                local inv = 1 / total_w
                for _, o in ipairs(overlaps) do
                    o.w = o.w * inv
                end
            end

            if #overlaps <= 0 then
                goto continue
            end

            entries[#entries + 1] = {
                local_idx = local_idx,
                target_idx = actual_index_by_local[local_idx] or local_idx,
                overlaps = overlaps,
            }

            ::continue::
        end

        rt[key] = {
            port = p.port,
            outputId = p.outputId,
            segmentId = p.segmentId,
            placementId = p.id,
            localLedCount = p.ledsCount or total_leds,
            brightness = p.brightness or 100,
            leds = entries,
        }
    end

    return rt
end

--- Mix canvas frame colours through the routing table.
--
-- @param canvas_colors  Flat array of R,G,B bytes (1-based, length = grid_width * grid_height * 3).
-- @param rt             Routing table from `build()`.
-- @return table  Keyed identically to `rt`, values are arrays of
--   { target_idx, r, g, b } tuples ready for `ext.set_leds`.
function M.route(canvas_colors, rt)
    local result = {}

    for key, entry in pairs(rt) do
        local leds = entry.leds
        local n = #leds
        local brightness = entry.brightness or 100
        local factor = brightness < 100 and (brightness / 100) or nil
        local colors = {}
        local preview_colors = {}
        local preview_count = max(0, floor((entry.localLedCount or 0) + 0.5))

        for i = 1, preview_count do
            preview_colors[i] = { r = 0, g = 0, b = 0 }
        end

        for i = 1, n do
            local overlaps = leds[i].overlaps
            local r, g, b = 0, 0, 0

            for _, o in ipairs(overlaps) do
                local base = o.idx * 3 + 1    -- canvas_colors is 1-based, idx is 0-based
                local cr = canvas_colors[base]     or 0
                local cg = canvas_colors[base + 1] or 0
                local cb = canvas_colors[base + 2] or 0
                r = r + cr * o.w
                g = g + cg * o.w
                b = b + cb * o.w
            end

            if factor then
                r = r * factor
                g = g * factor
                b = b * factor
            end

            local rr = floor(r + 0.5)
            local gg = floor(g + 0.5)
            local bb = floor(b + 0.5)

            colors[#colors + 1] = {
                leds[i].target_idx or (i - 1),
                rr,
                gg,
                bb,
            }

            local preview_idx = (leds[i].local_idx or (i - 1)) + 1
            if preview_idx > 0 then
                preview_colors[preview_idx] = {
                    r = rr,
                    g = gg,
                    b = bb,
                }
            end
        end

        result[key] = {
            port = entry.port,
            outputId = entry.outputId,
            segmentId = entry.segmentId,
            placementId = entry.placementId,
            colors = colors,
            preview = preview_colors,
        }
    end

    return result
end

return M
