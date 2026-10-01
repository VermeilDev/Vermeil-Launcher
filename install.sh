#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║              Vermeil Launcher — Linux Installer                 ║
# ╚══════════════════════════════════════════════════════════════════╝
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/VermeilDev/Vermeil-Launcher/main/install.sh | bash
#
# Uninstall:
#   vermeil-uninstall

set -euo pipefail

REPO="VermeilDev/Vermeil-Launcher"
APP_NAME="Vermeil"
APP_ID="com.vermeil.launcher"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
DATA_DIR="$HOME/.local/share/Vermeil"
DESKTOP_DIR="$HOME/Desktop"

# ── Helpers ─────────────────────────────────────────────────────────

# Brief 1-second spinner. The work it overlays (env-var reads) is instant;
# the animation exists so the "Detecting..." step is actually visible
# instead of flashing past in a single render.
spin_briefly() {
  local label="$1"
  local frames='|/-\'
  local i=0
  while [ "$i" -lt 12 ]; do
    printf '\r  %s %s' "${frames:$((i % 4)):1}" "$label"
    sleep 0.08
    i=$((i + 1))
  done
  printf '\r\033[K'
}

# Detect the user's desktop environment from environment variables. Returns
# a normalized lowercase identifier; "unknown" for anything we don't model.
#
# Tiling compositors are checked first because some distros leave
# XDG_CURRENT_DESKTOP unset under them, but every major one exports its own
# socket/signature variable (HYPRLAND_INSTANCE_SIGNATURE, SWAYSOCK,
# NIRI_SOCKET).
detect_desktop() {
  if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then echo "hyprland"; return; fi
  if [ -n "${SWAYSOCK:-}" ]; then echo "sway"; return; fi
  if [ -n "${NIRI_SOCKET:-}" ]; then echo "niri"; return; fi

  local raw="${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-}}"
  case "${raw,,}" in
    *gnome*|*unity*) echo "gnome" ;;
    *kde*|*plasma*) echo "kde" ;;
    *xfce*) echo "xfce" ;;
    *cinnamon*) echo "cinnamon" ;;
    *mate*) echo "mate" ;;
    *lxqt*) echo "lxqt" ;;
    *lxde*) echo "lxde" ;;
    *budgie*) echo "budgie" ;;
    *pantheon*) echo "pantheon" ;;
    *deepin*) echo "deepin" ;;
    *enlightenment*) echo "enlightenment" ;;
    *i3*) echo "i3" ;;
    *dwm*) echo "dwm" ;;
    *bspwm*) echo "bspwm" ;;
    *awesome*) echo "awesome" ;;
    *river*) echo "river" ;;
    *) echo "unknown" ;;
  esac
}

# Pretty display name for the detected DE.
desktop_label() {
  case "$1" in
    kde) echo "KDE Plasma" ;;
    xfce) echo "Xfce" ;;
    cinnamon) echo "Cinnamon" ;;
    mate) echo "MATE" ;;
    lxqt) echo "LXQt" ;;
    lxde) echo "LXDE" ;;
    pantheon) echo "Pantheon" ;;
    deepin) echo "Deepin" ;;
    gnome) echo "GNOME" ;;
    budgie) echo "Budgie" ;;
    unity) echo "Unity" ;;
    hyprland) echo "Hyprland" ;;
    sway) echo "sway" ;;
    i3) echo "i3" ;;
    dwm) echo "dwm" ;;
    bspwm) echo "bspwm" ;;
    awesome) echo "awesome" ;;
    river) echo "river" ;;
    niri) echo "Niri" ;;
    enlightenment) echo "Enlightenment" ;;
    *) echo "an unrecognized desktop" ;;
  esac
}

# Classify how well the DE handles a `.desktop` file dropped on ~/Desktop.
#
#   native    — paints it as an icon out of the box. KDE, Xfce, Cinnamon, MATE.
#   extension — has a desktop surface but needs an opt-in addon to draw icons
#               on it. GNOME (Desktop Icons NG / DING), Budgie, Unity.
#   none      — no desktop surface at all; tiling/dynamic compositors that
#               cover the screen with windows. Hyprland, sway, i3, niri, etc.
#   unknown   — couldn't identify; fall back to a conservative "ask anyway".
desktop_icon_tier() {
  case "$1" in
    kde|xfce|cinnamon|mate|lxqt|lxde|pantheon|deepin|enlightenment) echo "native" ;;
    gnome|budgie|unity) echo "extension" ;;
    hyprland|sway|i3|dwm|bspwm|awesome|river|niri) echo "none" ;;
    *) echo "unknown" ;;
  esac
}

# ── Banner ──────────────────────────────────────────────────────────

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     Vermeil Launcher — Installer      ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  A tactile Minecraft launcher         ║"
echo "  ║  for Windows and Linux                ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# ── Confirmation ────────────────────────────────────────────────────

printf "  Install Vermeil Launcher? [Y/n] "
read -r CONFIRM < /dev/tty
if [[ "${CONFIRM,,}" == "n" ]]; then
  echo "  Cancelled."
  exit 0
fi

# ── Detect existing install ─────────────────────────────────────────

if [ -f "$BIN_DIR/Vermeil.AppImage" ]; then
  echo ""
  echo "  Existing installation found at $BIN_DIR/Vermeil.AppImage"
  printf "  Overwrite with latest version? [Y/n] "
  read -r OVERWRITE < /dev/tty
  if [[ "${OVERWRITE,,}" == "n" ]]; then
    echo "  Cancelled."
    exit 0
  fi
  echo "  Removing old version..."
  rm -f "$BIN_DIR/Vermeil.AppImage"
fi

# ── Fetch latest release ────────────────────────────────────────────

echo ""
echo "  Fetching latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -Po '"tag_name": "\K[^"]+' || true)
if [ -z "$LATEST" ]; then
  LATEST=$(curl -fsSL "https://raw.githubusercontent.com/$REPO/updates/latest.json" 2>/dev/null | grep -Po '"version": "\K[^"]+' || true)
  if [ -n "$LATEST" ]; then
    LATEST="v$LATEST"
  fi
fi
if [ -z "$LATEST" ]; then
  echo "  Error: Could not determine latest release version." >&2
  exit 1
fi
VERSION="${LATEST#v}"
echo "  Latest version: $VERSION"

# ── Download ────────────────────────────────────────────────────────

APPIMAGE_NAME="${APP_NAME}_${VERSION}_amd64.AppImage"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$APPIMAGE_NAME"

mkdir -p "$BIN_DIR"
echo "  Downloading $APPIMAGE_NAME..."
curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$BIN_DIR/Vermeil.AppImage"
chmod +x "$BIN_DIR/Vermeil.AppImage"
echo "  Downloaded to $BIN_DIR/Vermeil.AppImage"

# ── Desktop entry (app menu) ───────────────────────────────────────

mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/$APP_ID.desktop" << EOF
[Desktop Entry]
Name=Vermeil
Comment=A tactile, privacy-focused Minecraft launcher
Exec=env WEBKIT_DISABLE_DMABUF_RENDERER=1 $BIN_DIR/Vermeil.AppImage
Icon=vermeil
Type=Application
Categories=Game;
StartupWMClass=Vermeil
Terminal=false
EOF

# ── Extract icon ────────────────────────────────────────────────────

mkdir -p "$ICONS_DIR"
# Extract icon from AppImage
cd /tmp
"$BIN_DIR/Vermeil.AppImage" --appimage-extract "*.png" &>/dev/null || true
"$BIN_DIR/Vermeil.AppImage" --appimage-extract "usr/share/icons/*" &>/dev/null || true
ICON_FOUND=""
for candidate in \
  "squashfs-root/usr/share/icons/hicolor/128x128/apps/"*.png \
  "squashfs-root/128x128.png" \
  "squashfs-root/icon.png" \
  "squashfs-root/"*.png; do
  if [ -f "$candidate" ]; then
    ICON_FOUND="$candidate"
    break
  fi
done
if [ -n "$ICON_FOUND" ]; then
  cp "$ICON_FOUND" "$ICONS_DIR/vermeil.png"
fi
rm -rf squashfs-root
cd - >/dev/null

# Update icon cache
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

# ── Desktop shortcut (DE-aware) ─────────────────────────────────────
#
# A `.desktop` file dropped on ~/Desktop only renders as an icon if the
# user's environment actually paints a desktop surface. KDE, Xfce, Cinnamon,
# MATE and friends do that out of the box; GNOME needs the DING extension;
# tiling compositors (Hyprland, sway, i3, niri...) have no desktop concept
# at all. Detect first, adapt the prompt second.

echo ""
spin_briefly "Detecting desktop environment..."
DE=$(detect_desktop)
DE_LABEL=$(desktop_label "$DE")
TIER=$(desktop_icon_tier "$DE")
echo "  Detected: $DE_LABEL"
echo ""

case "$TIER" in
  native)
    if [ -d "$DESKTOP_DIR" ]; then
      printf "  Create a desktop shortcut? [Y/n] "
      read -r SHORTCUT < /dev/tty
      if [[ "${SHORTCUT,,}" != "n" ]]; then
        cp "$APPS_DIR/$APP_ID.desktop" "$DESKTOP_DIR/$APP_ID.desktop"
        chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
        echo "  Desktop shortcut created."
      fi
    fi
    ;;
  extension)
    if [ "$DE" = "gnome" ]; then
      echo "  GNOME doesn't show desktop icons out of the box. To enable them,"
      echo "  install the Desktop Icons NG (DING) extension once, then any"
      echo "  shortcut on ~/Desktop will start showing up:"
      echo "    https://extensions.gnome.org/extension/5263/desktop-icons-ng/"
    else
      echo "  $DE_LABEL needs a desktop-icons component enabled before"
      echo "  shortcuts on the desktop will appear."
    fi
    if [ -d "$DESKTOP_DIR" ]; then
      echo ""
      printf "  Place the shortcut on your Desktop anyway (it shows up once enabled)? [y/N] "
      read -r SHORTCUT < /dev/tty
      if [[ "${SHORTCUT,,}" == "y" ]]; then
        cp "$APPS_DIR/$APP_ID.desktop" "$DESKTOP_DIR/$APP_ID.desktop"
        chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
        echo "  Desktop file written."
      fi
    fi
    ;;
  none)
    echo "  $DE_LABEL doesn't have a desktop surface, so a desktop icon"
    echo "  doesn't apply here. Vermeil is in your application launcher"
    echo "  (rofi, wofi, fuzzel, anyrun, dmenu, etc.)."
    ;;
  unknown)
    echo "  Couldn't recognise this desktop (XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-unset}')."
    if [ -d "$DESKTOP_DIR" ]; then
      printf "  Create a desktop shortcut anyway? [y/N] "
      read -r SHORTCUT < /dev/tty
      if [[ "${SHORTCUT,,}" == "y" ]]; then
        cp "$APPS_DIR/$APP_ID.desktop" "$DESKTOP_DIR/$APP_ID.desktop"
        chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
        echo "  Desktop shortcut created."
      fi
    fi
    ;;
esac

# ── Create uninstall script ─────────────────────────────────────────

cat > "$BIN_DIR/vermeil-uninstall" << 'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail

APP_ID="com.vermeil.launcher"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
DATA_DIR="$HOME/.local/share/Vermeil"
DESKTOP_DIR="$HOME/Desktop"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║    Vermeil Launcher — Uninstaller     ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

printf "  Remove Vermeil Launcher? [Y/n] "
read -r CONFIRM < /dev/tty
if [[ "${CONFIRM,,}" == "n" ]]; then
  echo "  Cancelled."
  exit 0
fi

echo "  Removing application..."
rm -f "$BIN_DIR/Vermeil.AppImage"
rm -f "$APPS_DIR/$APP_ID.desktop"
rm -f "$DESKTOP_DIR/$APP_ID.desktop" 2>/dev/null || true
rm -f "$ICONS_DIR/vermeil.png"

echo ""
if [ -d "$DATA_DIR" ] || [ -d "$HOME/.config/com.vermeil.launcher" ] || [ -d "$HOME/.local/share/com.vermeil.launcher" ]; then
  echo "  App data found:"
  [ -d "$DATA_DIR" ] && echo "    $DATA_DIR (instances, accounts, settings, mods)"
  [ -d "$HOME/.config/com.vermeil.launcher" ] && echo "    ~/.config/com.vermeil.launcher (window state, config)"
  [ -d "$HOME/.local/share/com.vermeil.launcher" ] && echo "    ~/.local/share/com.vermeil.launcher (WebView cache)"
  printf "  Delete all app data and cache? [y/N] "
  read -r DELETE_DATA < /dev/tty
  if [[ "${DELETE_DATA,,}" == "y" ]]; then
    rm -rf "$DATA_DIR"
    rm -rf "$HOME/.config/com.vermeil.launcher"
    rm -rf "$HOME/.local/share/com.vermeil.launcher"
    echo "  All app data and cache deleted."
  else
    echo "  App data preserved."
  fi
fi

# Remove self
rm -f "$BIN_DIR/vermeil-uninstall"

update-desktop-database "$APPS_DIR" 2>/dev/null || true
echo ""
echo "  Vermeil has been uninstalled."
echo ""
UNINSTALL
chmod +x "$BIN_DIR/vermeil-uninstall"

# ── Done ────────────────────────────────────────────────────────────

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Installation complete!         ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  Run:        Vermeil.AppImage         ║"
echo "  ║  Uninstall:  vermeil-uninstall        ║"
echo "  ║  App data:   ~/.local/share/Vermeil   ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Vermeil should appear in your application menu."
echo "  Open a new terminal for 'vermeil-uninstall' to work."
echo ""

# Check PATH and auto-fix if needed
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  # Determine which shell RC file to update
  SHELL_RC=""
  if [ -n "${ZSH_VERSION:-}" ] || [ "$SHELL" = "$(which zsh 2>/dev/null)" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.profile" ]; then
    SHELL_RC="$HOME/.profile"
  fi

  if [ -n "$SHELL_RC" ]; then
    echo "  Adding $BIN_DIR to PATH in $SHELL_RC..."
    echo "" >> "$SHELL_RC"
    echo "# Added by Vermeil installer" >> "$SHELL_RC"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    export PATH="$HOME/.local/bin:$PATH"
    echo "  Done. PATH updated for this session and future shells."
  else
    echo "  NOTE: Could not detect shell RC file."
    echo "  Add this manually to your shell config:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  echo ""
fi
