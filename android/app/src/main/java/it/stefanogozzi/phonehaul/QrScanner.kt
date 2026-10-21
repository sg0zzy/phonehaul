package org.phonehaul.app

import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.EnumMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun QrScanner(
    onFound: (String) -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val executor = Executors.newSingleThreadExecutor()
        val main = Handler(Looper.getMainLooper())
        val found = AtomicBoolean(false)
        val disposed = AtomicBoolean(false)
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        val listener =
            Runnable {
                try {
                    if (disposed.get()) return@Runnable
                    provider = providerFuture.get()
                    val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                    val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis.setAnalyzer(executor) { image ->
                        try {
                            if (!found.get()) {
                                val data = luminance(image)
                                val reader =
                                    MultiFormatReader().apply {
                                        setHints(
                                            EnumMap<DecodeHintType, Any>(DecodeHintType::class.java).apply {
                                                put(DecodeHintType.POSSIBLE_FORMATS, listOf(com.google.zxing.BarcodeFormat.QR_CODE))
                                                put(DecodeHintType.TRY_HARDER, true)
                                            },
                                        )
                                    }
                                val source =
                                    PlanarYUVLuminanceSource(data, image.width, image.height, 0, 0, image.width, image.height, false)
                                val decoded = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
                                PairingParser.parse(decoded)
                                if (found.compareAndSet(false, true)) main.post { onFound(decoded) }
                            }
                        } catch (
                            _: com.google.zxing.NotFoundException,
                        ) {
                            // Next frame
                        } catch (
                            e: IllegalArgumentException,
                        ) {
                            main.post { onError(e.message ?: "Invalid QR code") }
                        } catch (
                            _: Exception,
                        ) {
                            // Damaged frame; keep scanning
                        } finally {
                            image.close()
                        }
                    }
                    provider?.unbindAll()
                    provider?.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (e: Exception) {
                    onError(e.message ?: "Unable to start camera")
                }
            }
        providerFuture.addListener(listener, ContextCompat.getMainExecutor(context))
        onDispose {
            disposed.set(true)
            provider?.unbindAll()
            executor.shutdownNow()
        }
    }
    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxWidth().height(320.dp))
}

private fun luminance(image: ImageProxy): ByteArray {
    val plane = image.planes[0]
    val buffer = plane.buffer.duplicate()
    val width = image.width
    val height = image.height
    val output = ByteArray(width * height)
    for (row in 0 until height) {
        for (col in 0 until width) output[row * width + col] = buffer.get(row * plane.rowStride + col * plane.pixelStride)
    }
    return output
}
