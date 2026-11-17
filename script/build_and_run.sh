#!/bin/bash
set -euo pipefail

mode=${1:-run}
case "$mode" in
  run|--build|--verify) ;;
  --dmg)
    if [[ ${2:-} != *.dmg ]]; then
      printf 'Usage: %s --dmg output.dmg\n' "$0" >&2
      exit 2
    fi
    dmg=$2
    [[ "$dmg" == /* ]] || dmg="$PWD/$dmg"
    ;;
  *) printf 'Usage: %s [--build|--verify|--dmg output.dmg]\n' "$0" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
root=$PWD
mkdir -p "$root/.build/module-cache"
export CLANG_MODULE_CACHE_PATH="$root/.build/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$root/.build/module-cache"

build_flags=(-c release --disable-sandbox --manifest-cache local -debug-info-format none)
if [[ "$mode" != --dmg ]]; then
  swift build "${build_flags[@]}"
  binary="$(swift build "${build_flags[@]}" --show-bin-path)/PiDesktop"
fi

# Workspace builds validate a package. Updates follow the existing installed app.
destination="$HOME/Desktop/Pi.app"
stage_parent="$root/.build"
if [[ "$mode" == run || "$mode" == --verify ]]; then
  if /usr/bin/pgrep -x PiDesktop >/dev/null; then
    printf '请退出 Pi 后再更新。\n' >&2
    exit 1
  elif [[ $? != 1 ]]; then
    exit 1
  fi
  existing=""
  for candidate in /Applications/Pi.app "$HOME/Applications/Pi.app" "$destination"; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    id=$(/usr/bin/plutil -extract CFBundleIdentifier raw "$candidate/Contents/Info.plist" 2>/dev/null) || continue
    [[ "$id" == local.pi-desktop ]] || continue
    if [[ -n "$existing" && ! "$candidate" -ef "$existing" ]]; then
      printf '找到多份 Pi：%s、%s。无法确定要更新哪一份。\n' "$existing" "$candidate" >&2
      exit 1
    fi
    existing="$candidate"
  done
  destination="${existing:-$destination}"
  stage_parent="$(dirname "$destination")"
  if [[ -z "$existing" && ( -e "$destination" || -L "$destination" ) ]]; then
    printf '目标位置已有其他文件：%s\n' "$destination" >&2
    exit 1
  fi
fi

stage=$(mktemp -d "$stage_parent/.pi-build.XXXXXX")
installed=false
cleanup() {
  if [[ "$installed" == false && -d "$stage/previous" ]]; then
    if [[ -d "$destination" ]]; then mv "$destination" "$stage/failed" || return; fi
    mv "$stage/previous" "$destination" || return
  fi
  rm -rf "$stage"
}
trap cleanup EXIT
app="$stage/candidate"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/Web" "$app/Contents/Resources/Engine"
if [[ "$mode" == --dmg ]]; then
  binaries=()
  for arch in arm64 x86_64; do
    flags=("${build_flags[@]}" --triple "$arch-apple-macosx13.0" --scratch-path "$root/.build/package-$arch")
    swift build "${flags[@]}"
    binaries+=("$(swift build "${flags[@]}" --show-bin-path)/PiDesktop")
  done
  /usr/bin/lipo -create "${binaries[@]}" -output "$app/Contents/MacOS/PiDesktop"
  arches=" $(/usr/bin/lipo -archs "$app/Contents/MacOS/PiDesktop") "
  [[ "$arches" == *" arm64 "* && "$arches" == *" x86_64 "* ]]
else
  cp "$binary" "$app/Contents/MacOS/PiDesktop"
fi
cp Resources/Info.plist "$app/Contents/Info.plist"
cp Resources/Pi.icns "$app/Contents/Resources/Pi.icns"
cp Resources/Web/* "$app/Contents/Resources/Web/"
cp Resources/Engine/* "$app/Contents/Resources/Engine/"
/usr/bin/plutil -lint "$app/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --strict "$app"

if [[ "$mode" == --dmg ]]; then
  disk="$stage/disk"
  mkdir -p "$disk" "$(dirname "$dmg")"
  mv "$app" "$disk/Pi.app"
  ln -s /Applications "$disk/Applications"
  /usr/bin/hdiutil create -fs HFS+ -format UDZO -volname Pi -srcfolder "$disk" "$stage/Pi.dmg"
  /usr/bin/hdiutil verify "$stage/Pi.dmg"
  mv "$stage/Pi.dmg" "$dmg"
  printf '%s\n' "$dmg"
  exit 0
fi

if [[ "$mode" == --build ]]; then
  printf '已验证构建产物 %s\n' "$binary"
  exit 0
fi

if [[ -e "$destination" ]]; then
  mv "$destination" "$stage/previous"
fi
mv "$app" "$destination"
/usr/bin/codesign --verify --strict "$destination"
installed=true
cleanup
trap - EXIT
printf '%s\n' "$destination"

/usr/bin/open "$destination"
if [[ "$mode" == --verify ]]; then
  for attempt in {1..10}; do
    if /usr/bin/pgrep -x PiDesktop >/dev/null; then exit 0; fi
    sleep 1
  done
  printf 'Pi.app did not stay running.\n' >&2
  exit 1
fi
