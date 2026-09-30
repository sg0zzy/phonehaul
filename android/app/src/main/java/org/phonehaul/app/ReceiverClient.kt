package org.phonehaul.app

import android.content.ContentResolver
import android.net.Uri
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

data class PreparedFile(val source: SourceItem, val size: Long, val sha256: String?)
data class UploadResult(val status: String, val size: Long?, val sha256: String?)
data class TransferPlan(val transferId: String, val dispositions: Map<String, String>)
class ReceiverHttpException(val statusCode: Int, message: String) : IOException(message)

class ReceiverClient(private val resolver: ContentResolver, private val pairing: Pairing) {
    @Volatile private var active: HttpsURLConnection? = null
    private val sslContext: SSLContext = SSLContext.getInstance("TLS").apply {
        val manager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw java.security.cert.CertificateException("Missing receiver certificate")
                val actual = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded).hex()
                if (actual != pairing.fingerprint) throw java.security.cert.CertificateException("Receiver certificate does not match QR code")
            }
        }
        init(null, arrayOf<TrustManager>(manager), null)
    }

    private fun connection(method: String, route: String): HttpsURLConnection {
        val url = URL("https://${pairing.host}:${pairing.port}$route")
        return (url.openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = sslContext.socketFactory
            hostnameVerifier = javax.net.ssl.HostnameVerifier { host, _ -> host == pairing.host }
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 30_000
            setRequestProperty("Authorization", "Bearer ${pairing.token}")
            setRequestProperty("X-PhoneHaul-Capabilities", "send-to-phone")
            setRequestProperty("Accept", "application/json")
            useCaches = false
        }
    }

    private fun readResponse(connection: HttpsURLConnection): JSONObject {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val raw = stream?.bufferedReader()?.use { it.readText() } ?: ""
        val result = try { JSONObject(raw) } catch (_: Exception) { throw IOException("Invalid receiver response ($code)") }
        if (code !in 200..299) throw ReceiverHttpException(code, result.optString("error", "Receiver rejected request ($code)"))
        return result
    }

    private fun call(method: String, route: String, data: JSONObject? = null): JSONObject {
        val conn = connection(method, route)
        active = conn
        try {
            if (data != null) {
                val bytes = data.toString().toByteArray(Charsets.UTF_8)
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            return readResponse(conn)
        } finally { conn.disconnect(); active = null }
    }

    fun connect(): Boolean {
        val response = call("POST", "/api/session/connect")
        if (response.optInt("protocol") != 1) throw IOException("Unsupported receiver protocol")
        val capabilities = response.optJSONArray("capabilities") ?: throw IOException("Computer receiver needs an update to support streaming transfers")
        if ((0 until capabilities.length()).none { capabilities.optString(it) == "incremental-transfer" }) throw IOException("Computer receiver needs an update to support streaming transfers")
        return (0 until capabilities.length()).any { capabilities.optString(it) == "send-to-phone" }
    }

    suspend fun hashAndSize(uri: Uri, onBytes: (Long) -> Unit = {}): Pair<Long, String> {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        val stream = resolver.openInputStream(uri) ?: throw IOException("Cannot read selected file")
        stream.use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
                currentCoroutineContext().ensureActive()
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
                total += n
                onBytes(total)
            }
        }
        return total to digest.digest().hex()
    }

    fun createTransfer(items: List<SourceItem>, prepared: Map<String, PreparedFile>, mode: TransferMode): TransferPlan {
        val entries = JSONArray()
        for (item in items) {
            val entry = JSONObject().put("id", item.id).put("type", if (item.isDirectory) "directory" else "file").put("relativePath", item.relativePath)
            if (!item.isDirectory) {
                entry.put("size", prepared.getValue(item.id).size)
                prepared.getValue(item.id).sha256?.let { entry.put("sha256", it) }
                item.modified?.let { entry.put("modified", it) }
            }
            entries.put(entry)
        }
        val request = JSONObject().put("protocol", 1).put("operation", mode.name.lowercase()).put("items", entries)
        val response = call("POST", "/api/transfers", request)
        val statuses = buildMap {
            val results = response.getJSONArray("items")
            for (index in 0 until results.length()) {
                val item = results.getJSONObject(index)
                put(item.getString("id"), item.getString("status"))
            }
        }
        return TransferPlan(response.getString("transferId"), statuses)
    }

    fun appendFile(transferId: String, file: PreparedFile): String {
        val item = file.source
        val entry = JSONObject().put("id", item.id).put("type", "file")
            .put("relativePath", item.relativePath).put("size", file.size)
        file.sha256?.let { entry.put("sha256", it) }
        item.modified?.let { entry.put("modified", it) }
        return call("POST", "/api/transfers/$transferId/items", entry).getString("status")
    }

    suspend fun upload(transferId: String, file: PreparedFile, onBytes: (Long) -> Unit): UploadResult {
        val conn = connection("PUT", "/api/transfers/$transferId/files/${file.source.id}")
        active = conn
        try {
            conn.doOutput = true
            conn.readTimeout = 60_000
            file.sha256?.let { conn.setRequestProperty("X-PhoneHaul-SHA256", it) }
            conn.setFixedLengthStreamingMode(file.size)
            val digest = MessageDigest.getInstance("SHA-256")
            val stream = resolver.openInputStream(file.source.uri) ?: throw IOException("Cannot reopen selected file")
            stream.use { input -> conn.outputStream.use { output ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val n = input.read(buffer)
                    if (n < 0) break
                    digest.update(buffer, 0, n)
                    output.write(buffer, 0, n)
                    onBytes(n.toLong())
                }
            } }
            val actualHash = digest.digest().hex()
            val response = readResponse(conn)
            val status = response.getString("status")
            if (status != "committed" && status != "skipped" && status != "already_present") throw IOException("Unexpected receiver acknowledgement")
            if (status != "skipped" && (response.optLong("size", -1) != file.size || response.optString("sha256") != actualHash || (file.sha256 != null && file.sha256 != actualHash))) throw IOException("Receiver acknowledgement mismatch")
            return UploadResult(status, response.optLong("size"), response.optString("sha256"))
        } finally { conn.disconnect(); active = null }
    }

    fun finish(transferId: String) { call("POST", "/api/transfers/$transferId/finish") }
    fun cancel(transferId: String) { call("POST", "/api/transfers/$transferId/cancel") }
    fun cancelActive() { active?.disconnect() }

    fun nextIncoming(): IncomingFile? {
        val response = call("GET", "/api/send/next")
        if (response.isNull("item") && !response.has("id")) return null
        return IncomingFile(response.getString("id"), response.getString("relativePath"), response.getLong("size"), response.getString("sha256"))
    }

    fun receiveIncoming(file: IncomingFile) {
        val conn = connection("GET", "/api/send/${file.id}/content")
        try {
            if (conn.responseCode != 200 || conn.contentLengthLong != file.size) throw IOException("Invalid incoming file response")
            conn.inputStream.use { input -> PhoneInbox(resolver).save(file, input) }
        } finally { conn.disconnect() }
    }

    fun acknowledgeIncoming(id: String, state: String, error: String? = null) {
        call("POST", "/api/send/$id/complete", JSONObject().put("state", state).put("error", error))
    }
}

private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
