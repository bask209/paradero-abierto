#!/usr/bin/env bash
# Runs inside the Android emulator job: installs the APK, puts the phone in
# Chapinero, drives the app with Maestro and keeps screenshots and logs.
set -uo pipefail

APP=io.github.bask209.paraderoabierto
OUT=${OUT:-e2e-out}
mkdir -p "$OUT"

adb install -r app.apk
adb shell pm grant "$APP" android.permission.ACCESS_FINE_LOCATION || true
adb shell pm grant "$APP" android.permission.ACCESS_COARSE_LOCATION || true
adb shell settings put secure location_mode 3 || true

# Keep a fix coming, so expo-location always has a recent one.
( while true; do adb emu geo fix -74.0628 4.6486 >/dev/null 2>&1; sleep 3; done ) &
GEO=$!

adb logcat -c
adb logcat -v time > "$OUT/logcat.txt" &
LOG=$!

status=0
"$HOME/.maestro/bin/maestro" test .maestro/smoke.yaml --format junit --output "$OUT/report.xml" --test-output-dir "$OUT/maestro" || status=$?

# Whatever happened, keep a picture of the end state.
adb exec-out screencap -p > "$OUT/99-final.png" || true
kill "$GEO" "$LOG" 2>/dev/null || true

grep -E "ReactNativeJS|AndroidRuntime|FATAL" "$OUT/logcat.txt" | tail -200 > "$OUT/js-log.txt" || true
find . -maxdepth 4 -name "*.png" -newer app.apk -not -path "./$OUT/*" -exec cp {} "$OUT/" \; 2>/dev/null || true
exit $status
