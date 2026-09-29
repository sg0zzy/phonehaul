# Android client

The native Android client supports Android 11+ (API 30+). It uses CameraX and ZXing to scan the receiver's QR, pins the receiver TLS certificate fingerprint, and rejects non-private IPv4 endpoints. The app has no accounts or background synchronization.

Selection uses Android's document picker for multiple files, the tree picker for folders, and a MediaStore browser for photos and videos. The MediaStore browser may show only the items Android grants permission to access. Android 11+ restricts some tree locations, including the storage root and Downloads root.

COPY leaves sources unchanged. MOVE uploads one file at a time and deletes each supported file only after a `committed` receiver response. If the receiver proves a destination file already has the same size and SHA-256, that duplicate source may also be removed safely. MediaStore deletion uses Android's confirmation prompt after files are committed. Skipped, failed, and uncommitted files remain on the phone. Source folders remain in place. If deletion fails or is declined, the computer copy stays intact and the app reports the original as remaining.

Build with `ANDROID_HOME=/path/to/Android/Sdk ./gradlew :app:assembleDebug :app:testDebugUnitTest` from this directory. Install `app/build/outputs/apk/debug/app-debug.apk` on a phone. A real phone and receiver on the same LAN are needed for camera, provider deletion, and transfer validation.
