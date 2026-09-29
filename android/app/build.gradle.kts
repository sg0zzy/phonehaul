import java.util.Properties

val keystoreProperties = Properties()
val keystorePropertiesFile =
    file("${System.getProperty("user.home")}/.secrets/android/phonehaul/keystore.properties")

if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(keystorePropertiesFile.inputStream())
}

// CI can provide the same signing values as environment variables. Local builds
// continue to use ~/.secrets/android/phonehaul/keystore.properties.
val releaseStoreFile = System.getenv("ANDROID_KEYSTORE_FILE")
    ?: (keystoreProperties["storeFile"] as? String)
val releaseStorePassword = System.getenv("ANDROID_STORE_PASSWORD")
    ?: (keystoreProperties["storePassword"] as? String)
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
    ?: (keystoreProperties["keyAlias"] as? String)
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
    ?: (keystoreProperties["keyPassword"] as? String)


plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.phonehaul.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.phonehaul.app"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }

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
