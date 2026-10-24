package it.stefanogozzi.phonehaul

import android.annotation.SuppressLint
import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID

/** Trusted, packaged Internet client. Remote sites never receive the native bridge. */
class InternetActivity : ComponentActivity() {
    private lateinit var web: WebView
    private val inbox = Inbox()
    private var chooser: ValueCallback<Array<Uri>>? = null
    private val picker =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            chooser?.onReceiveValue(uris.toTypedArray())
            chooser = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = true
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.addJavascriptInterface(inbox, "PhoneHaulNative")
        web.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean = request.url.scheme != "https" || request.url.host != HOST

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    if (request.url.scheme != "https" || request.url.host != HOST) return null
                    val path = request.url.path ?: return null
                    if (path == "/internet/config") {
                        return response(
                            "application/json",
                            JSONObject()
                                .put("mode", "android")
                                .put("maxFileBytes", MAX_FILE)
                                .put("invitationMs", 15 * 60_000)
                                .put("recoveryMs", 10 * 60_000)
                                .put("signalingUrl", "")
                                .toString(),
                        )
                    }
                    val asset =
                        when (path) {
                            "/internet/" -> "internet/index.html"
                            "/internet/client.js" -> "internet/client.js"
                            else -> return response("text/plain", "Not found", 404)
                        }
                    val mime = if (asset.endsWith(".html")) "text/html" else "text/javascript"
                    return assets.open(asset).use { response(mime, it.bufferedReader().readText()) }
                }
            }
        web.webChromeClient =
            object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    chooser?.onReceiveValue(null)
                    chooser = callback
                    picker.launch(arrayOf("*/*"))
                    return true
                }
            }
        setContentView(web)
        val fragment = intent.getStringExtra("invitation")?.let { Uri.parse(it).encodedFragment }
        web.loadUrl("https://$HOST/internet/" + (fragment?.let { "#$it" } ?: ""))
    }

    private fun response(
        mime: String,
        body: String,
        status: Int = 200,
    ): WebResourceResponse =
        WebResourceResponse(
            mime,
            "utf-8",
            status,
            if (status == 200) "OK" else "Not Found",
            mapOf(
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
                "Content-Security-Policy" to
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                    "img-src 'self' data:; connect-src https:; object-src 'none'; base-uri 'none'",
            ),
            ByteArrayInputStream(body.toByteArray()),
        )

    override fun onDestroy() {
        chooser?.onReceiveValue(null)
        inbox.close()
        web.removeJavascriptInterface("PhoneHaulNative")
        web.destroy()
        super.onDestroy()
    }

    private inner class Inbox {
        private var uri: Uri? = null
        private var output: OutputStream? = null
        private var id: String? = null
        private var size = 0L
        private var bytes = 0L
        private var hash: MessageDigest? = null

        @JavascriptInterface
        @Synchronized
        fun call(
            action: String,
            raw: String,
        ): String =
            try {
                require(raw.length <= 30_000) { "Message too large" }
                val data = JSONObject(raw)
                val result =
                    when (action) {
                        "begin" -> begin(data)
                        "write" -> {
                            require(data.getString("id") == id) { "Invalid receive" }
                            val chunk = Base64.decode(data.getString("bytes"), Base64.NO_WRAP)
                            require(chunk.size <= 16 * 1024 && bytes + chunk.size <= size) { "Invalid chunk size" }
                            output!!.write(chunk)
                            hash!!.update(chunk)
                            bytes += chunk.size
                            JSONObject().put("status", "written")
                        }
                        "finish" -> {
                            require(data.getString("id") == id && bytes == size) { "Incomplete file" }
                            val digest = hash!!.digest().joinToString("") { "%02x".format(it) }
                            require(digest == data.getString("sha256")) { "File checksum mismatch" }
                            output!!.flush()
                            output!!.close()
                            output = null
                            val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                            check(contentResolver.update(uri!!, values, null, null) == 1) { "Cannot publish Downloads file" }
                            uri = null
                            id = null
                            JSONObject().put("status", "committed").put("size", bytes).put("sha256", digest)
                        }
                        "abort" -> {
                            require(data.getString("id") == id) { "Invalid receive" }
                            close()
                            JSONObject().put("status", "cancelled")
                        }
                        else -> error("Unknown operation")
                    }
                result.toString()
            } catch (error: Exception) {
                close()
                JSONObject().put("error", error.message ?: "Receive failed").toString()
            }

        private fun begin(data: JSONObject): JSONObject {
            check(uri == null) { "An Internet receive is already active" }
            val relative = data.getString("relativePath")
            val original = PhoneInboxPath.name(relative)
            size = data.getLong("size")
            val limit = data.getLong("limit")
            require(limit in 1..MAX_FILE && size in 0..limit) { "Internet file limit exceeded" }
            val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val name =
                Names.uniqueName(original, { candidate ->
                    contentResolver
                        .query(
                            collection,
                            arrayOf(MediaStore.Downloads._ID),
                            "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.DISPLAY_NAME}=?",
                            arrayOf("Download/", candidate),
                            null,
                        )?.use { it.moveToFirst() } ?: false
                })
            val values =
                ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.RELATIVE_PATH, "Download/")
                    put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
            uri = contentResolver.insert(collection, values) ?: error("Cannot create Downloads file")
            output = contentResolver.openOutputStream(uri!!, "w") ?: error("Cannot open Downloads file")
            id = UUID.randomUUID().toString()
            hash = MessageDigest.getInstance("SHA-256")
            bytes = 0
            return JSONObject().put("id", id)
        }

        @Synchronized
        fun close() {
            runCatching { output?.close() }
            output = null
            uri?.let { runCatching { contentResolver.delete(it, null, null) } }
            uri = null
            id = null
        }
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val MAX_FILE = 64L * 1024 * 1024 * 1024
    }
}
