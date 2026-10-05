// Release signing + version injection for `expo prebuild` output.
//
// CI drops release.keystore into android/app/ and sets RELAY_KEYSTORE_PASSWORD
// (+ RELAY_KEY_ALIAS). When that file exists the release build signs with the
// real key; without it gradle falls back to the debug config so a plain
// `expo prebuild && ./gradlew assembleRelease` still yields an installable
// APK for development. RELAY_VERSION_CODE overrides versionCode (CI passes
// GITHUB_RUN_NUMBER so every release bumps monotonically).
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_BLOCK = `
        release {
            def ksFile = rootProject.file('app/release.keystore')
            if (ksFile.exists()) {
                storeFile ksFile
                storePassword System.getenv("RELAY_KEYSTORE_PASSWORD")
                keyAlias System.getenv("RELAY_KEY_ALIAS") ?: 'relay'
                keyPassword System.getenv("RELAY_KEY_PASSWORD") ?: System.getenv("RELAY_KEYSTORE_PASSWORD")
            }
        }`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;

    // Add the release signingConfig next to the generated debug block.
    if (!g.includes("storeFile ksFile")) {
      g = g.replace(
        /(signingConfigs \{[\s\S]*?)\n    \}/,
        `$1${RELEASE_BLOCK}\n    }`,
      );
    }

    // Release uses the real config when the keystore is present, debug
    // otherwise — single buildType switch, no forks.
    g = g.replace(
      /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      `$1signingConfig (rootProject.file('app/release.keystore').exists()
                ? signingConfigs.release
                : signingConfigs.debug)`,
    );

    // versionCode/versionName from the environment for monotonic releases.
    g = g.replace(
      /versionCode \d+/,
      `versionCode Integer.parseInt(System.getenv("RELAY_VERSION_CODE") ?: "1")`,
    );
    g = g.replace(
      /versionName "[^"]*"/,
      `versionName (System.getenv("RELAY_VERSION_NAME") ?: "1.0.0")`,
    );

    c.modResults.contents = g;
    return c;
  });
};
