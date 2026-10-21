import java.util.Properties

// --- canonical version adapter (VERSIONING.md) -------------------------
// The repository-root VERSION file is the single source of truth. versionName
// is the display version; versionCode uses the bounded scheme
//   core = major*100000 + minor*1000 + patch; versionCode = core*1000 + slot
// with dev slots 1..998 (PHONEHAUL_DEV_N) and stable slot 999
// (PHONEHAUL_OFFICIAL=1). Fails closed on overflow or an invalid VERSION.
// Keep the scheme in sync with scripts/shared/version.js.
val canonicalVersion: String =
    rootProject.file("../VERSION").readText().trim().also { text ->
        require(Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-dev(?:\\.\\d+)?)?$").matches(text)) {
            "PhoneHaul version: invalid VERSION content '$text': expected X.Y.Z or X.Y.Z-dev (VERSIONING.md)."
        }
    }
val versionCore = canonicalVersion.substringBefore("-dev")
val isOfficialBuild = System.getenv("PHONEHAUL_OFFICIAL") == "1"
val devNumberRaw = System.getenv("PHONEHAUL_DEV_N")?.trim() ?: "1"
require(Regex("^[1-9]\\d*$").matches(devNumberRaw)) {
    "PhoneHaul version: invalid PHONEHAUL_DEV_N '$devNumberRaw': expected a positive integer without leading zeroes (VERSIONING.md)."
}
val devNumber = devNumberRaw.toInt()

if (isOfficialBuild) {
    require(!canonicalVersion.contains("-dev")) {
        "PhoneHaul version: official builds require a stable VERSION (found $canonicalVersion)."
    }
}

val versionParts = versionCore.split('.').map { it.toLong() }
require(versionParts.size == 3 && versionParts.all { it >= 0 }) {
    "PhoneHaul version: invalid core $versionCore."
}
require(versionParts[0] <= 20 && versionParts[1] <= 99 && versionParts[2] <= 999) {
    "PhoneHaul version: core $versionCore exceeds the Android versionCode allocation " +
        "(major<=20, minor<=99, patch<=999); change the documented allocation before distributing (VERSIONING.md)."
}
val versionSlot: Int =
    if (isOfficialBuild) {
        999
    } else {
        require(devNumber <= 998) {
            "PhoneHaul version: dev.$devNumber exceeds the Android dev slot range 1..998; advance the core or " +
                "use a centrally managed allocator before distributing (VERSIONING.md)."
        }
        devNumber
    }
val derivedVersionCode: Int =
    versionParts[0].toInt() * 100_000_000 + versionParts[1].toInt() * 1_000_000 +
        versionParts[2].toInt() * 1000 + versionSlot
require(derivedVersionCode <= 2_100_000_000) {
    "PhoneHaul version: versionCode $derivedVersionCode exceeds the Google Play cap 2100000000."
}
val derivedVersionName: String =
    if (isOfficialBuild) versionCore else "$versionCore-${System.getenv("PHONEHAUL_CHANNEL") ?: "dev"}.$devNumber"

val keystoreProperties = Properties()
val keystorePropertiesFile =
    file("${System.getProperty("user.home")}/.secrets/android/phonehaul/keystore.properties")

if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(keystorePropertiesFile.inputStream())
}

// CI can provide the same signing values as environment variables. Local builds
// continue to use ~/.secrets/android/phonehaul/keystore.properties.
val releaseStoreFile =
    System.getenv("ANDROID_KEYSTORE_FILE")
        ?: (keystoreProperties["storeFile"] as? String)
val releaseStorePassword =
    System.getenv("ANDROID_STORE_PASSWORD")
        ?: (keystoreProperties["storePassword"] as? String)
val releaseKeyAlias =
    System.getenv("ANDROID_KEY_ALIAS")
        ?: (keystoreProperties["keyAlias"] as? String)
val releaseKeyPassword =
    System.getenv("ANDROID_KEY_PASSWORD")
        ?: (keystoreProperties["keyPassword"] as? String)

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jlleitschuh.gradle.ktlint")
}

android {
    namespace = "it.stefanogozzi.phonehaul"
    compileSdk = 36

    defaultConfig {
        applicationId = "it.stefanogozzi.phonehaul"
        minSdk = 30
        targetSdk = 36
        versionCode = derivedVersionCode
        versionName = derivedVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }

    lint {
        abortOnError = true
        baseline = file("lint-baseline.xml")
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.camera:camera-core:1.4.2")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}
