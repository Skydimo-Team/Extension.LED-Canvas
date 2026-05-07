use std::ffi::{c_char, c_void};

pub const SKYDIMO_NATIVE_C_ABI_VERSION: u32 = 2;
pub const SKYDIMO_PLUGIN_KIND_EXTENSION: u32 = 1 << 2;

pub const SKYDIMO_LOG_INFO: u32 = 2;
pub const SKYDIMO_LOG_WARN: u32 = 3;
pub const SKYDIMO_LOG_ERROR: u32 = 4;

pub type HostLogFn = unsafe extern "C" fn(*mut c_void, u32, *const c_char, usize);
pub type HostCallJsonFn = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    usize,
    *const c_char,
    usize,
    *mut u8,
    usize,
    *mut usize,
) -> i32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoStr {
    pub ptr: *const c_char,
    pub len: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoRgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoMatrixMapV1 {
    pub width: usize,
    pub height: usize,
    pub map: *const i64,
    pub map_len: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoLayoutTransformV1 {
    pub flip_horizontal: u8,
    pub flip_vertical: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoOutputCapabilitiesV1 {
    pub editable: u8,
    pub min_total_leds: usize,
    pub max_total_leds: usize,
    pub allowed_total_leds: *const usize,
    pub allowed_total_leds_len: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoOutputDefinitionV1 {
    pub id: SkydimoStr,
    pub name: SkydimoStr,
    pub output_type: u32,
    pub leds_count: usize,
    pub matrix: *const SkydimoMatrixMapV1,
    pub transform: SkydimoLayoutTransformV1,
    pub capabilities: SkydimoOutputCapabilitiesV1,
    pub default_effect: SkydimoStr,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoOutputFrameV1 {
    pub output_id: SkydimoStr,
    pub colors: *const SkydimoRgb,
    pub colors_len: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoLedColorV1 {
    pub index: usize,
    pub color: SkydimoRgb,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoDeviceInfoV1 {
    pub manufacturer: SkydimoStr,
    pub model: SkydimoStr,
    pub serial_id: SkydimoStr,
    pub description: SkydimoStr,
    pub device_type: u32,
    pub image_url: SkydimoStr,
    pub controller_id: SkydimoStr,
    pub controller_name: SkydimoStr,
    pub device_path: SkydimoStr,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoHardwareCandidateV1 {
    pub candidate_type: u32,
    pub port_key: SkydimoStr,
    pub path: SkydimoStr,
    pub vendor_id: u32,
    pub product_id: u32,
    pub has_vendor_id: u8,
    pub has_product_id: u8,
    pub interface_number: i32,
    pub has_interface_number: u8,
    pub serial_number: SkydimoStr,
    pub manufacturer_string: SkydimoStr,
    pub product_string: SkydimoStr,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SkydimoHostApiV1 {
    pub size: u32,
    pub abi_version: u32,
    pub host_ctx: *mut c_void,
    pub log: Option<HostLogFn>,
    pub call_json: Option<HostCallJsonFn>,
    pub controller_set_device_info:
        Option<unsafe extern "C" fn(*mut c_void, *const SkydimoDeviceInfoV1) -> i32>,
    pub controller_add_output:
        Option<unsafe extern "C" fn(*mut c_void, *const SkydimoOutputDefinitionV1) -> i32>,
    pub controller_output_led_count:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> usize>,
    pub controller_get_rgb_bytes:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize, *mut u8, usize) -> isize>,
    pub controller_write: Option<unsafe extern "C" fn(*mut c_void, *const u8, usize) -> isize>,
    pub controller_read: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize, u32) -> isize>,
    pub controller_hid_send_feature_report:
        Option<unsafe extern "C" fn(*mut c_void, *const u8, usize) -> isize>,
    pub controller_hid_get_feature_report:
        Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize, u8) -> isize>,
    pub extension_lock_leds: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            usize,
            *const c_char,
            usize,
            *const usize,
            usize,
            *mut usize,
            *mut usize,
        ) -> i32,
    >,
    pub extension_unlock_leds: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            usize,
            *const c_char,
            usize,
            *const usize,
            usize,
        ) -> i32,
    >,
    pub extension_set_leds_rgb: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            usize,
            *const c_char,
            usize,
            *const SkydimoLedColorV1,
            usize,
        ) -> i32,
    >,
}

impl Default for SkydimoHostApiV1 {
    fn default() -> Self {
        Self {
            size: std::mem::size_of::<Self>() as u32,
            abi_version: SKYDIMO_NATIVE_C_ABI_VERSION,
            host_ctx: std::ptr::null_mut(),
            log: None,
            call_json: None,
            controller_set_device_info: None,
            controller_add_output: None,
            controller_output_led_count: None,
            controller_get_rgb_bytes: None,
            controller_write: None,
            controller_read: None,
            controller_hid_send_feature_report: None,
            controller_hid_get_feature_report: None,
            extension_lock_leds: None,
            extension_unlock_leds: None,
            extension_set_leds_rgb: None,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoEffectApiV1 {
    pub size: u32,
    pub create: Option<unsafe extern "C" fn(*const SkydimoHostApiV1, *mut *mut c_void) -> i32>,
    pub destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    pub resize: Option<unsafe extern "C" fn(*mut c_void, u32, u32, u32) -> i32>,
    pub update_params_json: Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> i32>,
    pub tick: Option<unsafe extern "C" fn(*mut c_void, f64, *mut SkydimoRgb, usize) -> i32>,
    pub is_ready: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoControllerApiV1 {
    pub size: u32,
    pub create: Option<
        unsafe extern "C" fn(
            *const SkydimoHostApiV1,
            *const SkydimoHardwareCandidateV1,
            *mut *mut c_void,
        ) -> i32,
    >,
    pub destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    pub validate: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub init: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub get_device_info: Option<unsafe extern "C" fn(*mut c_void, *mut SkydimoDeviceInfoV1) -> i32>,
    pub get_output_count: Option<unsafe extern "C" fn(*mut c_void) -> usize>,
    pub get_output:
        Option<unsafe extern "C" fn(*mut c_void, usize, *mut SkydimoOutputDefinitionV1) -> i32>,
    pub update: Option<unsafe extern "C" fn(*mut c_void, *const SkydimoOutputFrameV1, usize) -> i32>,
    pub set_output_leds_count:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize, usize) -> i32>,
    pub update_output:
        Option<unsafe extern "C" fn(*mut c_void, *const SkydimoOutputDefinitionV1) -> i32>,
    pub disconnect: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoExtensionApiV1 {
    pub size: u32,
    pub create: Option<unsafe extern "C" fn(*const SkydimoHostApiV1, *mut *mut c_void) -> i32>,
    pub destroy: Option<unsafe extern "C" fn(*mut c_void)>,
    pub start: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub stop: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub on_scan_devices: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub on_event_json:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize, *const c_char, usize) -> i32>,
    pub on_page_message_json: Option<unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> i32>,
    pub on_device_frame: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            usize,
            *const SkydimoOutputFrameV1,
            usize,
        ) -> i32,
    >,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SkydimoPluginApiV1 {
    pub size: u32,
    pub abi_version: u32,
    pub kind_mask: u32,
    pub effect: SkydimoEffectApiV1,
    pub controller: SkydimoControllerApiV1,
    pub extension: SkydimoExtensionApiV1,
    pub shutdown_plugin: Option<unsafe extern "C" fn()>,
}

pub unsafe fn ffi_str(ptr: *const c_char, len: usize) -> String {
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) };
    String::from_utf8_lossy(bytes).into_owned()
}
