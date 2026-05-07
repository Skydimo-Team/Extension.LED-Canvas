use serde_json::{json, Value};

use crate::abi::{
    HostLogFn, SkydimoHostApiV1, SkydimoLedColorV1, SKYDIMO_LOG_ERROR, SKYDIMO_LOG_INFO,
    SKYDIMO_LOG_WARN,
};

#[derive(Clone, Copy)]
pub struct Host {
    api: SkydimoHostApiV1,
}

impl Host {
    pub unsafe fn from_raw(raw: *const SkydimoHostApiV1) -> Self {
        let api = if raw.is_null() {
            SkydimoHostApiV1::default()
        } else {
            unsafe { *raw }
        };
        Self { api }
    }

    pub fn call(&self, method: &str, request: Value) -> Result<Value, String> {
        let Some(call_json) = self.api.call_json else {
            return Err("native host does not expose call_json".to_string());
        };
        let method_bytes = method.as_bytes();
        let request_bytes = serde_json::to_vec(&request)
            .map_err(|err| format!("failed to encode host request '{method}': {err}"))?;
        let mut response = vec![0u8; 4096];

        loop {
            let mut required_len = 0usize;
            let status = unsafe {
                call_json(
                    self.api.host_ctx,
                    method_bytes.as_ptr().cast(),
                    method_bytes.len(),
                    request_bytes.as_ptr().cast(),
                    request_bytes.len(),
                    response.as_mut_ptr(),
                    response.len(),
                    &mut required_len as *mut usize,
                )
            };

            if status > 0 {
                let next_len = required_len.max(response.len().saturating_mul(2)).max(1);
                if next_len == response.len() {
                    return Err(format!("host response for '{method}' did not fit buffer"));
                }
                response.resize(next_len, 0);
                continue;
            }

            let used = required_len.min(response.len());
            let value = if used == 0 {
                Value::Null
            } else {
                serde_json::from_slice::<Value>(&response[..used])
                    .unwrap_or_else(|_| json!({ "error": format!("host status {status}") }))
            };

            if status < 0 {
                let detail = value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("host method '{method}' failed with status {status}"));
                return Err(detail);
            }

            return Ok(value);
        }
    }

    pub fn set_leds_rgb(
        &self,
        port: &str,
        output_id: &str,
        colors: &[SkydimoLedColorV1],
    ) -> Result<(), String> {
        let Some(set_leds) = self.api.extension_set_leds_rgb else {
            return Err("native host does not expose extension_set_leds_rgb".to_string());
        };
        let status = unsafe {
            set_leds(
                self.api.host_ctx,
                port.as_ptr().cast(),
                port.len(),
                output_id.as_ptr().cast(),
                output_id.len(),
                colors.as_ptr(),
                colors.len(),
            )
        };
        if status < 0 {
            Err(format!("extension_set_leds_rgb failed with status {status}"))
        } else {
            Ok(())
        }
    }

    pub fn lock_leds(&self, port: &str, output_id: &str, indices: &[usize]) -> Result<(usize, usize), String> {
        let Some(lock_leds) = self.api.extension_lock_leds else {
            return Err("native host does not expose extension_lock_leds".to_string());
        };
        let mut locked = 0usize;
        let mut rejected = 0usize;
        let status = unsafe {
            lock_leds(
                self.api.host_ctx,
                port.as_ptr().cast(),
                port.len(),
                output_id.as_ptr().cast(),
                output_id.len(),
                indices.as_ptr(),
                indices.len(),
                &mut locked as *mut usize,
                &mut rejected as *mut usize,
            )
        };
        if status < 0 {
            Err(format!("extension_lock_leds failed with status {status}"))
        } else {
            Ok((locked, rejected))
        }
    }

    pub fn unlock_leds(&self, port: &str, output_id: &str, indices: &[usize]) -> Result<(), String> {
        let Some(unlock_leds) = self.api.extension_unlock_leds else {
            return Err("native host does not expose extension_unlock_leds".to_string());
        };
        let status = unsafe {
            unlock_leds(
                self.api.host_ctx,
                port.as_ptr().cast(),
                port.len(),
                output_id.as_ptr().cast(),
                output_id.len(),
                indices.as_ptr(),
                indices.len(),
            )
        };
        if status < 0 {
            Err(format!("extension_unlock_leds failed with status {status}"))
        } else {
            Ok(())
        }
    }

    pub fn log_info(&self, msg: &str) {
        self.log(SKYDIMO_LOG_INFO, msg);
    }

    pub fn log_warn(&self, msg: &str) {
        self.log(SKYDIMO_LOG_WARN, msg);
    }

    pub fn log_error(&self, msg: &str) {
        self.log(SKYDIMO_LOG_ERROR, msg);
    }

    fn log(&self, level: u32, msg: &str) {
        let Some(log) = self.api.log else {
            return;
        };
        call_log(log, self.api.host_ctx, level, msg);
    }
}

fn call_log(log: HostLogFn, host_ctx: *mut std::ffi::c_void, level: u32, msg: &str) {
    unsafe {
        log(host_ctx, level, msg.as_ptr().cast(), msg.len());
    }
}
