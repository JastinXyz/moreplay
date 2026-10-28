#!/usr/bin/env bash
# Builds build/moreplay.jar (dex inside) for app_process. Needs ANDROID_HOME with platform + build-tools.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:?ANDROID_HOME not set}"
PLATFORM="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
BUILD_TOOLS="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"

# The agent reports this version on /ping so the server can tell a stale agent apart.
VERSION="$(node -p 'require("../package.json").version')"
rm -rf build && mkdir -p build/classes build/gen/dev/moreplay/agent
cat > build/gen/dev/moreplay/agent/Version.java <<JAVA
package dev.moreplay.agent;

final class Version {
    static final String NAME = "$VERSION";
}
JAVA
javac -source 11 -target 11 -Xlint:-options -cp "$PLATFORM" -d build/classes $(find src build/gen -name '*.java')
"$BUILD_TOOLS/d8" --min-api 26 --lib "$PLATFORM" --output build/moreplay.jar $(find build/classes -name '*.class')
echo "built $(pwd)/build/moreplay.jar"
