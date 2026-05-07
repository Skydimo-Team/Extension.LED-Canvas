use std::collections::HashMap;

use crate::abi::{SkydimoLedColorV1, SkydimoRgb};
use crate::model::{placement_routing_key, RuntimePlacement, Matrix};

const EPS: f64 = 1e-9;

#[derive(Clone, Debug, Default)]
pub struct RoutingTable {
    pub entries: HashMap<String, RouteEntry>,
}

#[derive(Clone, Debug)]
pub struct RouteEntry {
    pub port: String,
    pub output_id: String,
    pub placement_id: String,
    pub local_led_count: usize,
    pub brightness: u8,
    pub leds: Vec<RouteLed>,
}

#[derive(Clone, Debug)]
pub struct RouteLed {
    pub local_idx: usize,
    pub target_idx: usize,
    overlaps: Vec<Overlap>,
}

#[derive(Clone, Copy, Debug)]
struct Overlap {
    idx: usize,
    weight: f64,
}

#[derive(Clone, Debug)]
struct LedGeometry {
    rect: Rect,
    points: Option<[Point; 4]>,
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

pub struct RouteOutput {
    pub port: String,
    pub output_id: String,
    pub placement_id: String,
    pub colors: Vec<SkydimoLedColorV1>,
    pub preview_rgb: String,
}

pub fn build(placements: &[RuntimePlacement], grid_width: usize, grid_height: usize) -> RoutingTable {
    let grid_width = grid_width.max(1);
    let grid_height = grid_height.max(1);
    let mut table = RoutingTable::default();

    for placement in placements {
        let key = placement_routing_key(placement);
        let (cols, rows) = led_grid_dims(placement);
        let total_leds = if placement.leds_count > 0 {
            placement.leds_count
        } else {
            cols.saturating_mul(rows)
        };
        let led_rects = build_led_rects(placement, cols, rows, total_leds);
        let actual_by_local = placement
            .local_indices
            .iter()
            .zip(placement.actual_indices.iter())
            .map(|(local, actual)| (*local, *actual))
            .collect::<HashMap<_, _>>();
        let mut leds = Vec::with_capacity(placement.local_indices.len());

        for local_idx in &placement.local_indices {
            let Some(rect) = led_rects.get(*local_idx).and_then(Option::as_ref) else {
                continue;
            };
            let bounds = rect.rect;
            let cx_min = bounds.x1.floor().max(0.0) as usize;
            let cy_min = bounds.y1.floor().max(0.0) as usize;
            let cx_max_float = (bounds.x2 - EPS).floor().min((grid_width - 1) as f64);
            let cy_max_float = (bounds.y2 - EPS).floor().min((grid_height - 1) as f64);
            if cx_max_float < cx_min as f64 || cy_max_float < cy_min as f64 {
                continue;
            }
            let cx_max = cx_max_float as usize;
            let cy_max = cy_max_float as usize;
            let mut overlaps = Vec::new();
            let mut total_weight = 0.0;

            for cy in cy_min..=cy_max {
                for cx in cx_min..=cx_max {
                    let area = if let Some(points) = rect.points {
                        polygon_rect_overlap_area(&points, cx as f64, cy as f64, cx as f64 + 1.0, cy as f64 + 1.0)
                    } else {
                        overlap_area(
                            rect.rect,
                            Rect {
                                x1: cx as f64,
                                y1: cy as f64,
                                x2: cx as f64 + 1.0,
                                y2: cy as f64 + 1.0,
                            },
                        )
                    };
                    if area > EPS {
                        overlaps.push(Overlap {
                            idx: cy.saturating_mul(grid_width).saturating_add(cx),
                            weight: area,
                        });
                        total_weight += area;
                    }
                }
            }

            if total_weight <= 0.0 {
                continue;
            }
            let inv = 1.0 / total_weight;
            for overlap in &mut overlaps {
                overlap.weight *= inv;
            }
            leds.push(RouteLed {
                local_idx: *local_idx,
                target_idx: actual_by_local.get(local_idx).copied().unwrap_or(*local_idx),
                overlaps,
            });
        }

        table.entries.insert(key, RouteEntry {
            port: placement.port.clone(),
            output_id: placement.output_id.clone(),
            placement_id: placement.id.clone(),
            local_led_count: placement.leds_count,
            brightness: placement.brightness,
            leds,
        });
    }

    table
}

pub fn route(canvas: &[SkydimoRgb], table: &RoutingTable) -> Vec<RouteOutput> {
    let mut outputs = Vec::with_capacity(table.entries.len());

    for entry in table.entries.values() {
        let mut color_values = Vec::with_capacity(entry.leds.len());
        let mut preview = vec![SkydimoRgb::default(); entry.local_led_count];
        let brightness = if entry.brightness < 100 {
            Some(f64::from(entry.brightness) / 100.0)
        } else {
            None
        };

        for led in &entry.leds {
            let mut r = 0.0;
            let mut g = 0.0;
            let mut b = 0.0;

            for overlap in &led.overlaps {
                if let Some(color) = canvas.get(overlap.idx) {
                    r += f64::from(color.r) * overlap.weight;
                    g += f64::from(color.g) * overlap.weight;
                    b += f64::from(color.b) * overlap.weight;
                }
            }

            if let Some(factor) = brightness {
                r *= factor;
                g *= factor;
                b *= factor;
            }

            let color = SkydimoRgb {
                r: to_u8(r),
                g: to_u8(g),
                b: to_u8(b),
            };
            color_values.push(SkydimoLedColorV1 {
                index: led.target_idx,
                color,
            });
            if let Some(slot) = preview.get_mut(led.local_idx) {
                *slot = color;
            }
        }

        outputs.push(RouteOutput {
            port: entry.port.clone(),
            output_id: entry.output_id.clone(),
            placement_id: entry.placement_id.clone(),
            colors: color_values,
            preview_rgb: rgb_vec_base64(&preview),
        });
    }

    outputs
}

pub fn rgb_vec_base64(colors: &[SkydimoRgb]) -> String {
    let mut encoded = String::with_capacity(colors.len().saturating_mul(4));
    for color in colors {
        let packed = (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b);
        encoded.push(BASE64[(packed >> 18) as usize] as char);
        encoded.push(BASE64[((packed >> 12) & 0x3f) as usize] as char);
        encoded.push(BASE64[((packed >> 6) & 0x3f) as usize] as char);
        encoded.push(BASE64[(packed & 0x3f) as usize] as char);
    }
    encoded
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn led_grid_dims(placement: &RuntimePlacement) -> (usize, usize) {
    if let Some(matrix) = placement.matrix.as_ref() {
        if matrix.width > 0 && matrix.height > 0 {
            return (matrix.width, matrix.height);
        }
    }
    if placement.leds_count == 0 {
        (1, 1)
    } else {
        (placement.leds_count, 1)
    }
}

fn build_led_rects(
    placement: &RuntimePlacement,
    cols: usize,
    rows: usize,
    total_leds: usize,
) -> Vec<Option<LedGeometry>> {
    let dev_w = if placement.width > 0.0 { placement.width } else { cols as f64 };
    let dev_h = if placement.height > 0.0 { placement.height } else { rows as f64 };
    let origin_x = placement.x;
    let origin_y = placement.y;
    let rotation = placement.rotation.rem_euclid(360.0);
    let has_rotation = rotation.abs() > EPS;
    let angle = rotation.to_radians();
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    let center_x = origin_x + dev_w / 2.0;
    let center_y = origin_y + dev_h / 2.0;
    let led_w = dev_w / cols.max(1) as f64;
    let led_h = dev_h / rows.max(1) as f64;
    let mut rects = vec![None; total_leds];

    if let Some(matrix) = placement.matrix.as_ref() {
        build_matrix_rects(
            matrix,
            &mut rects,
            total_leds,
            origin_x,
            origin_y,
            led_w,
            led_h,
            has_rotation,
            center_x,
            center_y,
            cos_a,
            sin_a,
        );
    }

    for (led_index, slot) in rects.iter_mut().enumerate().take(total_leds) {
        if slot.is_none() {
            let col = led_index % cols.max(1);
            let row = led_index / cols.max(1);
            *slot = Some(make_led_geometry(
                origin_x + col as f64 * led_w,
                origin_y + row as f64 * led_h,
                origin_x + (col + 1) as f64 * led_w,
                origin_y + (row + 1) as f64 * led_h,
                has_rotation,
                center_x,
                center_y,
                cos_a,
                sin_a,
            ));
        }
    }

    rects
}

#[allow(clippy::too_many_arguments)]
fn build_matrix_rects(
    matrix: &Matrix,
    rects: &mut [Option<LedGeometry>],
    total_leds: usize,
    origin_x: f64,
    origin_y: f64,
    led_w: f64,
    led_h: f64,
    has_rotation: bool,
    center_x: f64,
    center_y: f64,
    cos_a: f64,
    sin_a: f64,
) {
    let cell_count = matrix.width.saturating_mul(matrix.height);
    for cell in 0..cell_count.min(matrix.map.len()) {
        let mapped = matrix.map[cell];
        if mapped < 0 {
            continue;
        }
        let Ok(led_index) = usize::try_from(mapped) else {
            continue;
        };
        if led_index >= total_leds || rects.get(led_index).and_then(Option::as_ref).is_some() {
            continue;
        }
        let col = cell % matrix.width.max(1);
        let row = cell / matrix.width.max(1);
        rects[led_index] = Some(make_led_geometry(
            origin_x + col as f64 * led_w,
            origin_y + row as f64 * led_h,
            origin_x + (col + 1) as f64 * led_w,
            origin_y + (row + 1) as f64 * led_h,
            has_rotation,
            center_x,
            center_y,
            cos_a,
            sin_a,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn make_led_geometry(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    has_rotation: bool,
    center_x: f64,
    center_y: f64,
    cos_a: f64,
    sin_a: f64,
) -> LedGeometry {
    if !has_rotation {
        return LedGeometry {
            rect: Rect { x1, y1, x2, y2 },
            points: None,
        };
    }

    let points = [
        rotate_point(x1, y1, center_x, center_y, cos_a, sin_a),
        rotate_point(x2, y1, center_x, center_y, cos_a, sin_a),
        rotate_point(x2, y2, center_x, center_y, cos_a, sin_a),
        rotate_point(x1, y2, center_x, center_y, cos_a, sin_a),
    ];
    let rect = points.iter().fold(
        Rect {
            x1: f64::INFINITY,
            y1: f64::INFINITY,
            x2: f64::NEG_INFINITY,
            y2: f64::NEG_INFINITY,
        },
        |mut acc, point| {
            acc.x1 = acc.x1.min(point.x);
            acc.y1 = acc.y1.min(point.y);
            acc.x2 = acc.x2.max(point.x);
            acc.y2 = acc.y2.max(point.y);
            acc
        },
    );

    LedGeometry {
        rect,
        points: Some(points),
    }
}

fn rotate_point(px: f64, py: f64, cx: f64, cy: f64, cos_a: f64, sin_a: f64) -> Point {
    let dx = px - cx;
    let dy = py - cy;
    Point {
        x: cx + dx * cos_a - dy * sin_a,
        y: cy + dx * sin_a + dy * cos_a,
    }
}

fn overlap_area(a: Rect, b: Rect) -> f64 {
    let ox = 0.0_f64.max(a.x2.min(b.x2) - a.x1.max(b.x1));
    let oy = 0.0_f64.max(a.y2.min(b.y2) - a.y1.max(b.y1));
    ox * oy
}

fn polygon_rect_overlap_area(points: &[Point; 4], x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let mut clipped = clip_polygon(points.as_slice(), |point| point.x >= x1 - EPS, |a, b| {
        let dx = b.x - a.x;
        let t = (x1 - a.x) / dx;
        Point { x: x1, y: a.y + (b.y - a.y) * t }
    });
    if clipped.is_empty() {
        return 0.0;
    }
    clipped = clip_polygon(&clipped, |point| point.x <= x2 + EPS, |a, b| {
        let dx = b.x - a.x;
        let t = (x2 - a.x) / dx;
        Point { x: x2, y: a.y + (b.y - a.y) * t }
    });
    if clipped.is_empty() {
        return 0.0;
    }
    clipped = clip_polygon(&clipped, |point| point.y >= y1 - EPS, |a, b| {
        let dy = b.y - a.y;
        let t = (y1 - a.y) / dy;
        Point { x: a.x + (b.x - a.x) * t, y: y1 }
    });
    if clipped.is_empty() {
        return 0.0;
    }
    clipped = clip_polygon(&clipped, |point| point.y <= y2 + EPS, |a, b| {
        let dy = b.y - a.y;
        let t = (y2 - a.y) / dy;
        Point { x: a.x + (b.x - a.x) * t, y: y2 }
    });
    polygon_area(&clipped)
}

fn clip_polygon(
    points: &[Point],
    inside: impl Fn(Point) -> bool,
    intersection: impl Fn(Point, Point) -> Point,
) -> Vec<Point> {
    let Some(mut prev) = points.last().copied() else {
        return Vec::new();
    };
    let mut result = Vec::with_capacity(points.len() + 2);
    let mut prev_inside = inside(prev);

    for curr in points.iter().copied() {
        let curr_inside = inside(curr);
        if prev_inside != curr_inside {
            result.push(intersection(prev, curr));
        }
        if curr_inside {
            result.push(curr);
        }
        prev = curr;
        prev_inside = curr_inside;
    }

    result
}

fn polygon_area(points: &[Point]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    let mut prev = points[points.len() - 1];
    for curr in points {
        area += prev.x * curr.y - curr.x * prev.y;
        prev = *curr;
    }
    area.abs() * 0.5
}

fn to_u8(value: f64) -> u8 {
    (value + 0.5).floor().clamp(0.0, 255.0) as u8
}
