#!/usr/bin/env bash
# Builds build/droidreplay.jar (dex inside) for app_process. Needs ANDROID_HOME with platform + build-tools.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:?ANDROID_HOME not set}"
PLATFORM="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
BUILD_TOOLS="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"

rm -rf build && mkdir -p build/classes
javac -source 11 -target 11 -Xlint:-options -cp "$PLATFORM" -d build/classes $(find src -name '*.java')
"$BUILD_TOOLS/d8" --min-api 26 --lib "$PLATFORM" --output build/droidreplay.jar $(find build/classes -name '*.class')
echo "built $(pwd)/build/droidreplay.jar"
