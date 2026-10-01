// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

//! Dynamic window, taskbar, system tray, and OS shortcut icon management.
//!
//! Provides pixel-perfect 32-bit ARGB icons for Windows (Win32 HWND) and Linux (WebKitGTK).
//! Fixes the Windows 11 Task Manager child-window distortion/black background bug caused
//! by Tao's monochrome 8-bit mask corruption, and dynamically switches the active application
//! icon across the Taskbar, Alt-Tab switcher, Window frame, System Tray, and Desktop shortcuts.

use tauri::{AppHandle, Manager};

// Embedded optimized theme PNG and ICO assets
const THEME_NEON_AURORA_16: &[u8] = include_bytes!("../../icons/themes/neon-aurora_16.png");
const THEME_NEON_AURORA_32: &[u8] = include_bytes!("../../icons/themes/neon-aurora_32.png");
const THEME_NEON_AURORA_256: &[u8] = include_bytes!("../../icons/themes/neon-aurora_256.png");
const THEME_NEON_AURORA_ICO: &[u8] = include_bytes!("../../icons/themes/neon-aurora.ico");

const THEME_INFERNO_16: &[u8] = include_bytes!("../../icons/themes/inferno_16.png");
const THEME_INFERNO_32: &[u8] = include_bytes!("../../icons/themes/inferno_32.png");
const THEME_INFERNO_256: &[u8] = include_bytes!("../../icons/themes/inferno_256.png");
const THEME_INFERNO_ICO: &[u8] = include_bytes!("../../icons/themes/inferno.ico");

const THEME_STEALTH_16: &[u8] = include_bytes!("../../icons/themes/stealth_16.png");
const THEME_STEALTH_32: &[u8] = include_bytes!("../../icons/themes/stealth_32.png");
const THEME_STEALTH_256: &[u8] = include_bytes!("../../icons/themes/stealth_256.png");
const THEME_STEALTH_ICO: &[u8] = include_bytes!("../../icons/themes/stealth.ico");

const THEME_DEEP_OCEAN_16: &[u8] = include_bytes!("../../icons/themes/deep-ocean_16.png");
const THEME_DEEP_OCEAN_32: &[u8] = include_bytes!("../../icons/themes/deep-ocean_32.png");
const THEME_DEEP_OCEAN_256: &[u8] = include_bytes!("../../icons/themes/deep-ocean_256.png");
const THEME_DEEP_OCEAN_ICO: &[u8] = include_bytes!("../../icons/themes/deep-ocean.ico");

const THEME_VOID_16: &[u8] = include_bytes!("../../icons/themes/void_16.png");
const THEME_VOID_32: &[u8] = include_bytes!("../../icons/themes/void_32.png");
const THEME_VOID_256: &[u8] = include_bytes!("../../icons/themes/void_256.png");
const THEME_VOID_ICO: &[u8] = include_bytes!("../../icons/themes/void.ico");

const THEME_EMERALD_16: &[u8] = include_bytes!("../../icons/themes/emerald_16.png");
const THEME_EMERALD_32: &[u8] = include_bytes!("../../icons/themes/emerald_32.png");
const THEME_EMERALD_256: &[u8] = include_bytes!("../../icons/themes/emerald_256.png");
const THEME_EMERALD_ICO: &[u8] = include_bytes!("../../icons/themes/emerald.ico");

pub struct ThemeIconAssets {
    pub png_16: &'static [u8],
    pub png_32: &'static [u8],
    pub png_256: &'static [u8],
    pub ico: &'static [u8],
}

pub fn get_theme_assets(theme_id: &str) -> ThemeIconAssets {
    match theme_id {
        "emerald" => ThemeIconAssets {
            png_16: THEME_EMERALD_16,
            png_32: THEME_EMERALD_32,
            png_256: THEME_EMERALD_256,
            ico: THEME_EMERALD_ICO,
        },
        "inferno" => ThemeIconAssets {
            png_16: THEME_INFERNO_16,
            png_32: THEME_INFERNO_32,
            png_256: THEME_INFERNO_256,
            ico: THEME_INFERNO_ICO,
        },
        "stealth" => ThemeIconAssets {
            png_16: THEME_STEALTH_16,
            png_32: THEME_STEALTH_32,
            png_256: THEME_STEALTH_256,
            ico: THEME_STEALTH_ICO,
        },
        "deep-ocean" => ThemeIconAssets {
            png_16: THEME_DEEP_OCEAN_16,
            png_32: THEME_DEEP_OCEAN_32,
            png_256: THEME_DEEP_OCEAN_256,
            ico: THEME_DEEP_OCEAN_ICO,
        },
        "void" => ThemeIconAssets {
            png_16: THEME_VOID_16,
            png_32: THEME_VOID_32,
            png_256: THEME_VOID_256,
            ico: THEME_VOID_ICO,
        },
        _ => ThemeIconAssets {
            png_16: THEME_NEON_AURORA_16,
            png_32: THEME_NEON_AURORA_32,
            png_256: THEME_NEON_AURORA_256,
            ico: THEME_NEON_AURORA_ICO,
        },
    }
}

#[cfg(windows)]
static PREV_HICON_SM: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(windows)]
static PREV_HICON_LG: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Ensure all theme .ico files exist in the permanent `theme_icons` directory.
/// Embedded directly in the binary via `include_bytes!`, so they can always be restored
/// even offline or after fresh installs, and are never touched by cache purges.
pub fn ensure_all_theme_icons_persisted() {
    let theme_ico_dir = crate::util::paths::theme_icons_dir();
    if let Err(e) = std::fs::create_dir_all(&theme_ico_dir) {
        tracing::warn!("Failed to create theme icons dir {:?}: {}", theme_ico_dir, e);
        return;
    }

    let themes = ["neon-aurora", "emerald", "inferno", "stealth", "deep-ocean", "void"];
    for t in themes {
        let assets = get_theme_assets(t);
        let path = theme_ico_dir.join(format!("{}.ico", t));
        if !path.exists()
            || path.metadata().map(|m| m.len()).unwrap_or(0) != assets.ico.len() as u64
        {
            let _ = std::fs::write(&path, assets.ico);
        }
    }
}

/// Apply the specified theme's icon across all active window, taskbar, tray,
/// and OS shortcut surfaces.
pub fn apply_theme_icon(app: &AppHandle, theme_id: &str) -> Result<(), String> {
    ensure_all_theme_icons_persisted();
    let assets = get_theme_assets(theme_id);

    // 1. Resolve the theme .ico from permanent <theme_icons_dir>/<theme_id>.ico
    let theme_ico_dir = crate::util::paths::theme_icons_dir();
    let ico_path = theme_ico_dir.join(format!("{}.ico", theme_id));

    // 2. Update the Main Window and Taskbar
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;
            use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                CreateIconFromResourceEx, DestroyIcon, SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM,
                ICON_BIG, ICON_SMALL, LR_DEFAULTCOLOR, WM_SETICON,
            };

            if let Ok(hwnd_raw) = window.hwnd() {
                let hwnd = hwnd_raw.0 as HWND;

                // Win32 CreateIconFromResourceEx natively decompresses PNGs since Windows Vista,
                // producing pristine 32-bit ARGB HICONs with true 8-bit alpha channels.
                let hicon_sm = unsafe {
                    CreateIconFromResourceEx(
                        assets.png_16.as_ptr(),
                        assets.png_16.len() as u32,
                        1, // TRUE = icon
                        0x00030000,
                        16,
                        16,
                        LR_DEFAULTCOLOR,
                    )
                };

                let cx_icon = unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                        windows_sys::Win32::UI::WindowsAndMessaging::SM_CXICON,
                    )
                };
                let cy_icon = unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
                        windows_sys::Win32::UI::WindowsAndMessaging::SM_CYICON,
                    )
                };

                let (lg_bytes, lg_len) = if cx_icon > 32 {
                    (assets.png_256.as_ptr(), assets.png_256.len() as u32)
                } else {
                    (assets.png_32.as_ptr(), assets.png_32.len() as u32)
                };

                let hicon_lg = unsafe {
                    CreateIconFromResourceEx(
                        lg_bytes,
                        lg_len,
                        1, // TRUE = icon
                        0x00030000,
                        cx_icon,
                        cy_icon,
                        LR_DEFAULTCOLOR,
                    )
                };

                if !hicon_sm.is_null() && !hicon_lg.is_null() {
                    unsafe {
                        // WM_SETICON with ICON_SMALL updates the window caption and Task Manager child tree node
                        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                            hwnd,
                            WM_SETICON,
                            ICON_SMALL as WPARAM,
                            hicon_sm as LPARAM,
                        );

                        // WM_SETICON with ICON_BIG updates the Windows Taskbar button and Alt+Tab switcher
                        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                            hwnd,
                            WM_SETICON,
                            ICON_BIG as WPARAM,
                            hicon_lg as LPARAM,
                        );

                        // Update window class icons for Explorer / Task Manager fallback queries
                        SetClassLongPtrW(hwnd, GCLP_HICONSM, hicon_sm as isize);
                        SetClassLongPtrW(hwnd, GCLP_HICON, hicon_lg as isize);

                        // Set PKEY_AppUserModel_RelaunchIconResource so Windows Explorer's taskbar
                        // matches the window to the active theme's icon resource even when grouped
                        // by explicit AppUserModelID.
                        if ico_path.exists() {
                            set_window_relaunch_icon(hwnd, &ico_path);
                        }
                    }

                    // Clean up previous dynamically created icons to avoid GDI/USER handle leaks
                    let old_sm = PREV_HICON_SM.swap(hicon_sm as isize, Ordering::SeqCst);
                    let old_lg = PREV_HICON_LG.swap(hicon_lg as isize, Ordering::SeqCst);
                    if old_sm != 0 {
                        unsafe { DestroyIcon(old_sm as _) };
                    }
                    if old_lg != 0 {
                        unsafe { DestroyIcon(old_lg as _) };
                    }
                } else {
                    tracing::warn!("Failed to create Win32 theme icon handles for {}", theme_id);
                }
            }
        }

        // On Linux / macOS (and cross-platform fallback), set the window icon via Tauri's API
        #[cfg(not(windows))]
        {
            if let Ok(img) = tauri::image::Image::from_bytes(assets.png_256)
                .or_else(|_| tauri::image::Image::from_bytes(assets.png_32))
                .or_else(|_| tauri::image::Image::from_bytes(assets.png_16))
            {
                let _ = window.set_icon(img);
            }
        }
    }

    // 3. Update System Tray Icon if present
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(img) = tauri::image::Image::from_bytes(assets.png_32)
            .or_else(|_| tauri::image::Image::from_bytes(assets.png_16))
        {
            let _ = tray.set_icon(Some(img));
        }
    }

    // 4. Synchronize Windows Desktop, Start Menu, and Pinned Taskbar Shortcuts asynchronously
    #[cfg(windows)]
    if ico_path.exists() {
        let ico_clone = ico_path.clone();
        std::thread::spawn(move || {
            sync_windows_shortcuts(&ico_clone);
        });
    }

    Ok(())
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct IUnknownVtbl {
    pub QueryInterface: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *const windows_sys::core::GUID,
        *mut *mut std::ffi::c_void,
    ) -> i32,
    pub AddRef: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
    pub Release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct IPersistFileVtbl {
    pub base: IUnknownVtbl,
    pub GetClassID: unsafe extern "system" fn(*mut std::ffi::c_void, *mut windows_sys::core::GUID) -> i32,
    pub IsDirty: unsafe extern "system" fn(*mut std::ffi::c_void) -> i32,
    pub Load: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16, u32) -> i32,
    pub Save: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16, i32) -> i32,
    pub SaveCompleted: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16) -> i32,
    pub GetCurFile: unsafe extern "system" fn(*mut std::ffi::c_void, *mut *mut u16) -> i32,
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct IShellLinkWVtbl {
    pub base: IUnknownVtbl,
    pub GetPath: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *mut u16,
        i32,
        *mut std::ffi::c_void,
        u32,
    ) -> i32,
    pub GetIDList: unsafe extern "system" fn(*mut std::ffi::c_void, *mut *mut std::ffi::c_void) -> i32,
    pub SetIDList: unsafe extern "system" fn(*mut std::ffi::c_void, *const std::ffi::c_void) -> i32,
    pub GetDescription: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16, i32) -> i32,
    pub SetDescription: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16) -> i32,
    pub GetWorkingDirectory: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16, i32) -> i32,
    pub SetWorkingDirectory: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16) -> i32,
    pub GetArguments: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16, i32) -> i32,
    pub SetArguments: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16) -> i32,
    pub GetHotkey: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16) -> i32,
    pub SetHotkey: unsafe extern "system" fn(*mut std::ffi::c_void, u16) -> i32,
    pub GetShowCmd: unsafe extern "system" fn(*mut std::ffi::c_void, *mut i32) -> i32,
    pub SetShowCmd: unsafe extern "system" fn(*mut std::ffi::c_void, i32) -> i32,
    pub GetIconLocation: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u16, i32, *mut i32) -> i32,
    pub SetIconLocation: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16, i32) -> i32,
    pub SetRelativePath: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16, u32) -> i32,
    pub Resolve: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        windows_sys::Win32::Foundation::HWND,
        u32,
    ) -> i32,
    pub SetPath: unsafe extern "system" fn(*mut std::ffi::c_void, *const u16) -> i32,
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct IPropertyStoreVtbl {
    pub base: IUnknownVtbl,
    pub GetCount: unsafe extern "system" fn(*mut std::ffi::c_void, *mut u32) -> i32,
    pub GetAt: unsafe extern "system" fn(*mut std::ffi::c_void, u32, *mut std::ffi::c_void) -> i32,
    pub GetValue: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *const std::ffi::c_void,
        *mut std::ffi::c_void,
    ) -> i32,
    pub SetValue: unsafe extern "system" fn(
        *mut std::ffi::c_void,
        *const Win32PropertyKey,
        *const Win32PropVariant,
    ) -> i32,
    pub Commit: unsafe extern "system" fn(*mut std::ffi::c_void) -> i32,
}

#[cfg(windows)]
#[repr(C)]
struct Win32PropertyKey {
    pub fmtid: windows_sys::core::GUID,
    pub pid: u32,
}

#[cfg(windows)]
#[repr(C)]
struct Win32PropVariant {
    pub vt: u16,
    pub w_reserved1: u16,
    pub w_reserved2: u16,
    pub w_reserved3: u16,
    pub pwsz_val: *mut u16,
    pub padding: usize,
}

#[cfg(windows)]
const CLSID_SHELL_LINK: windows_sys::core::GUID =
    windows_sys::core::GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
#[cfg(windows)]
const IID_ISHELL_LINK_W: windows_sys::core::GUID =
    windows_sys::core::GUID::from_u128(0x000214f9_0000_0000_c000_000000000046);
#[cfg(windows)]
const IID_IPERSIST_FILE: windows_sys::core::GUID =
    windows_sys::core::GUID::from_u128(0x0000010b_0000_0000_c000_000000000046);
#[cfg(windows)]
const IID_IPROPERTY_STORE: windows_sys::core::GUID =
    windows_sys::core::GUID::from_u128(0x886d8eeb_8cf2_4446_8d02_cdba1dbdcf99);
#[cfg(windows)]
const PKEY_RELAUNCH_ICON: Win32PropertyKey = Win32PropertyKey {
    fmtid: windows_sys::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 2,
};
#[cfg(windows)]
const VT_LPWSTR: u16 = 31;
#[cfg(all(windows, test))]
const STGM_READ: u32 = 0;
#[cfg(windows)]
const STGM_READWRITE: u32 = 2;

#[cfg(windows)]
extern "system" {
    fn SHGetPropertyStoreForWindow(
        hwnd: windows_sys::Win32::Foundation::HWND,
        riid: *const windows_sys::core::GUID,
        ppv: *mut *mut std::ffi::c_void,
    ) -> i32;
}

#[cfg(windows)]
unsafe fn set_window_relaunch_icon(
    hwnd: windows_sys::Win32::Foundation::HWND,
    ico_path: &std::path::Path,
) {
    let ico_resource = format!("{},0", ico_path.to_string_lossy());
    let mut ico_wide: Vec<u16> = ico_resource.encode_utf16().collect();
    ico_wide.push(0);

    let mut store_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let hr = SHGetPropertyStoreForWindow(hwnd, &IID_IPROPERTY_STORE, &mut store_ptr);
    if hr >= 0 && !store_ptr.is_null() {
        let vtbl = *(store_ptr as *const *const IPropertyStoreVtbl);
        let propvar = Win32PropVariant {
            vt: VT_LPWSTR,
            w_reserved1: 0,
            w_reserved2: 0,
            w_reserved3: 0,
            pwsz_val: ico_wide.as_mut_ptr(),
            padding: 0,
        };

        let _ = ((*vtbl).SetValue)(store_ptr, &PKEY_RELAUNCH_ICON, &propvar);
        let _ = ((*vtbl).Commit)(store_ptr);
        let _ = ((*vtbl).base.Release)(store_ptr);
    }
}

#[cfg(windows)]
static IS_SYNCING_SHORTCUTS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn update_shortcut_icon(
    lnk_path: &std::path::Path,
    ico_path: &std::path::Path,
) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let mut lnk_wide: Vec<u16> = lnk_path.as_os_str().encode_wide().collect();
    lnk_wide.push(0);

    let mut ico_wide: Vec<u16> = ico_path.as_os_str().encode_wide().collect();
    ico_wide.push(0);

    unsafe {
        let co_init = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        struct CoGuard(bool);
        impl Drop for CoGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }
        let _co_guard = CoGuard(co_init >= 0);

        let mut shell_link_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = CoCreateInstance(
            &CLSID_SHELL_LINK,
            std::ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_ISHELL_LINK_W,
            &mut shell_link_ptr,
        );
        if hr < 0 || shell_link_ptr.is_null() {
            return Err(format!("CoCreateInstance failed: hr=0x{:08X}", hr));
        }
        let shell_link_vtbl = *(shell_link_ptr as *const *const IShellLinkWVtbl);
        struct ShellRelease(*mut std::ffi::c_void, *const IShellLinkWVtbl);
        impl Drop for ShellRelease {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { ((*self.1).base.Release)(self.0) };
                }
            }
        }
        let _shell_guard = ShellRelease(shell_link_ptr, shell_link_vtbl);

        let mut persist_file_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = ((*shell_link_vtbl).base.QueryInterface)(
            shell_link_ptr,
            &IID_IPERSIST_FILE,
            &mut persist_file_ptr,
        );
        if hr < 0 || persist_file_ptr.is_null() {
            return Err(format!("QueryInterface IPersistFile failed: hr=0x{:08X}", hr));
        }
        let persist_file_vtbl = *(persist_file_ptr as *const *const IPersistFileVtbl);
        struct PersistRelease(*mut std::ffi::c_void, *const IPersistFileVtbl);
        impl Drop for PersistRelease {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe { ((*self.1).base.Release)(self.0) };
                }
            }
        }
        let _persist_guard = PersistRelease(persist_file_ptr, persist_file_vtbl);

        let hr = ((*persist_file_vtbl).Load)(
            persist_file_ptr,
            lnk_wide.as_ptr(),
            STGM_READWRITE,
        );
        if hr < 0 {
            return Err(format!("IPersistFile::Load failed: hr=0x{:08X}", hr));
        }

        // Fast path deduplication: check if shortcut already targets this exact icon AND the icon file exists on disk
        let mut cur_icon = [0u16; 1024];
        let mut cur_idx = -1i32;
        let hr_check = ((*shell_link_vtbl).GetIconLocation)(
            shell_link_ptr,
            cur_icon.as_mut_ptr(),
            cur_icon.len() as i32,
            &mut cur_idx,
        );
        if hr_check >= 0 && cur_idx == 0 {
            let len = cur_icon.iter().position(|&c| c == 0).unwrap_or(cur_icon.len());
            let cur_str = String::from_utf16_lossy(&cur_icon[..len]);
            if cur_str.eq_ignore_ascii_case(&ico_path.to_string_lossy()) && ico_path.exists() {
                return Ok(false);
            }
        }

        let hr = ((*shell_link_vtbl).SetIconLocation)(
            shell_link_ptr,
            ico_wide.as_ptr(),
            0,
        );
        if hr < 0 {
            return Err(format!("IShellLinkW::SetIconLocation failed: hr=0x{:08X}", hr));
        }

        let hr = ((*persist_file_vtbl).Save)(
            persist_file_ptr,
            lnk_wide.as_ptr(),
            1,
        );
        if hr < 0 {
            return Err(format!("IPersistFile::Save failed: hr=0x{:08X}", hr));
        }
    }

    Ok(true)
}

#[cfg(windows)]
fn find_vermeil_shortcuts() -> Vec<std::path::PathBuf> {
    let mut shortcuts = Vec::new();

    // Helper: collect any .lnk file whose file name contains "vermeil" (case-insensitive)
    let scan_folder = |dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>| {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("lnk") {
                        if let Some(stem) = path.file_stem() {
                            if stem.to_string_lossy().to_lowercase().contains("vermeil") {
                                out.push(path);
                            }
                        }
                    }
                }
            }
        }
    };

    // 1. User Desktop
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let desktop = std::path::PathBuf::from(profile).join("Desktop");
        scan_folder(&desktop, &mut shortcuts);
    }

    // 2. Public Desktop
    if let Some(public) = std::env::var_os("PUBLIC") {
        let pub_desktop = std::path::PathBuf::from(public).join("Desktop");
        scan_folder(&pub_desktop, &mut shortcuts);
    }

    // 3. User Start Menu & Pinned Taskbar
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let start_programs = std::path::PathBuf::from(&appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");

        scan_folder(&start_programs, &mut shortcuts);
        let vermeil_subfolder = start_programs.join("Vermeil");
        scan_folder(&vermeil_subfolder, &mut shortcuts);

        let taskbar_pinned = std::path::PathBuf::from(&appdata)
            .join("Microsoft")
            .join("Internet Explorer")
            .join("Quick Launch")
            .join("User Pinned")
            .join("TaskBar");

        scan_folder(&taskbar_pinned, &mut shortcuts);

        let ql = std::path::PathBuf::from(&appdata)
            .join("Microsoft")
            .join("Internet Explorer")
            .join("Quick Launch");
        scan_folder(&ql, &mut shortcuts);
    }

    // 4. Common / Machine Start Menu (ProgramData)
    if let Some(programdata) = std::env::var_os("PROGRAMDATA") {
        let common_programs = std::path::PathBuf::from(programdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");

        scan_folder(&common_programs, &mut shortcuts);
        let common_vermeil = common_programs.join("Vermeil");
        scan_folder(&common_vermeil, &mut shortcuts);
    }

    shortcuts.sort();
    shortcuts.dedup();
    shortcuts
}

#[cfg(windows)]
pub fn sync_windows_shortcuts(ico_path: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_IDLIST, SHCNF_PATHW,
    };

    if IS_SYNCING_SHORTCUTS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            IS_SYNCING_SHORTCUTS.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard;

    let shortcuts = find_vermeil_shortcuts();
    if shortcuts.is_empty() {
        return;
    }

    let mut changed_count = 0;
    for sc in &shortcuts {
        match update_shortcut_icon(sc, ico_path) {
            Ok(true) => {
                changed_count += 1;
                let mut sc_wide: Vec<u16> = sc.as_os_str().encode_wide().collect();
                sc_wide.push(0);
                unsafe {
                    SHChangeNotify(
                        SHCNE_UPDATEITEM as i32,
                        SHCNF_PATHW,
                        sc_wide.as_ptr() as _,
                        std::ptr::null(),
                    );
                }
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("Failed to update shortcut icon for {}: {}", sc.display(), e);
            }
        }
    }

    // Flush Windows Explorer shell icon cache so Taskbar and Desktop repaint immediately
    if changed_count > 0 {
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }

        tracing::info!(
            "Synchronized {} / {} Windows shortcuts to theme icon: {}",
            changed_count,
            shortcuts.len(),
            ico_path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_theme_assets_load() {
        let themes = ["neon-aurora", "emerald", "inferno", "stealth", "deep-ocean", "void"];
        for t in themes {
            let assets = get_theme_assets(t);
            assert!(assets.png_16.len() > 100, "Theme {} 16x16 PNG must be valid", t);
            assert!(assets.png_32.len() > 100, "Theme {} 32x32 PNG must be valid", t);
            assert!(assets.png_256.len() > 1000, "Theme {} 256x256 PNG must be valid", t);
            assert!(assets.ico.len() > 1000, "Theme {} .ico must be valid", t);
        }
    }

    #[test]
    #[cfg(windows)]
    fn test_com_shortcut_icon_update() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        };

        let temp_dir = std::env::temp_dir().join(format!("vermeil_test_sc_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let dummy_exe = temp_dir.join("test_app.exe");
        let _ = std::fs::write(&dummy_exe, b"test binary");

        let test_lnk = temp_dir.join("test_shortcut.lnk");
        let test_ico = temp_dir.join("test_theme.ico");
        let _ = std::fs::write(&test_ico, get_theme_assets("inferno").ico);

        // 1. Create a shortcut pointing to dummy_exe via COM
        let mut lnk_wide: Vec<u16> = test_lnk.as_os_str().encode_wide().collect();
        lnk_wide.push(0);
        let mut exe_wide: Vec<u16> = dummy_exe.as_os_str().encode_wide().collect();
        exe_wide.push(0);

        unsafe {
            let _ = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            let mut link_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_SHELL_LINK,
                std::ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_ISHELL_LINK_W,
                &mut link_ptr,
            );
            assert!(hr >= 0);
            let link_vtbl = *(link_ptr as *const *const IShellLinkWVtbl);
            let _ = ((*link_vtbl).SetPath)(link_ptr, exe_wide.as_ptr());

            let mut persist_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hr = ((*link_vtbl).base.QueryInterface)(link_ptr, &IID_IPERSIST_FILE, &mut persist_ptr);
            assert!(hr >= 0);
            let persist_vtbl = *(persist_ptr as *const *const IPersistFileVtbl);
            let hr = ((*persist_vtbl).Save)(persist_ptr, lnk_wide.as_ptr(), 1);
            assert!(hr >= 0);

            ((*persist_vtbl).base.Release)(persist_ptr);
            ((*link_vtbl).base.Release)(link_ptr);
            CoUninitialize();
        }

        assert!(test_lnk.exists(), "Test shortcut should have been created");

        // 2. Call update_shortcut_icon (first call: should modify the shortcut)
        let res = update_shortcut_icon(&test_lnk, &test_ico);
        assert!(res.is_ok(), "update_shortcut_icon failed: {:?}", res);
        assert_eq!(res.unwrap(), true, "First update should modify shortcut");

        // Fast-path deduplication: second call with same existing icon should return false
        let res_dup = update_shortcut_icon(&test_lnk, &test_ico);
        assert!(res_dup.is_ok());
        assert_eq!(res_dup.unwrap(), false, "Second update should deduplicate and return false");

        // 3. Read back the icon location to verify it matches test_ico
        unsafe {
            let _ = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            let mut link_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_SHELL_LINK,
                std::ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_ISHELL_LINK_W,
                &mut link_ptr,
            );
            assert!(hr >= 0);
            let link_vtbl = *(link_ptr as *const *const IShellLinkWVtbl);

            let mut persist_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hr = ((*link_vtbl).base.QueryInterface)(link_ptr, &IID_IPERSIST_FILE, &mut persist_ptr);
            assert!(hr >= 0);
            let persist_vtbl = *(persist_ptr as *const *const IPersistFileVtbl);
            let hr = ((*persist_vtbl).Load)(persist_ptr, lnk_wide.as_ptr(), STGM_READ);
            assert!(hr >= 0);

            let mut icon_buf = [0u16; 1024];
            let mut icon_idx = -1i32;
            let hr = ((*link_vtbl).GetIconLocation)(
                link_ptr,
                icon_buf.as_mut_ptr(),
                icon_buf.len() as i32,
                &mut icon_idx,
            );
            assert!(hr >= 0);

            ((*persist_vtbl).base.Release)(persist_ptr);
            ((*link_vtbl).base.Release)(link_ptr);
            CoUninitialize();

            let len = icon_buf.iter().position(|&c| c == 0).unwrap_or(icon_buf.len());
            let icon_str = String::from_utf16_lossy(&icon_buf[..len]);
            assert_eq!(icon_idx, 0);
            assert_eq!(
                icon_str.to_lowercase(),
                test_ico.to_string_lossy().to_lowercase(),
                "Icon location on shortcut must match the theme .ico path"
            );
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

