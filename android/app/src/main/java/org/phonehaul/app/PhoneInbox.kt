package org.phonehaul.app

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.InputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.Locale

data class IncomingFile(val id: String, val relativePath: String, val size: Long, val sha256: String)

object PhoneInboxPath {
    private const val ROOT = "Download/"

    fun parts(relative: String): List<String> {
        require(relative.isNotEmpty() && !relative.startsWith('/') && !relative.contains('\\') &&
            !Regex("^[A-Za-z]:").containsMatchIn(relative)) { "Invalid relative path" }
        val parts = relative.split('/')
        require(parts.all { it.isNotEmpty() && it != "." && it != ".." && it.none { c -> c.code < 32 || c == '\u007f' } }) { "Invalid relative path" }
        return parts
    }

    fun directory(relative: String): String {
        parts(relative)
        return ROOT
    }
    fun name(relative: String): String = parts(relative).last()

    fun imageMimeType(name: String): String? = when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "heic" -> "image/heic"
        "heif" -> "image/heif"
        "avif" -> "image/avif"
        "bmp" -> "image/bmp"
        else -> null
    }

    fun renamed(name: String, n: Int): String {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        return if (n == 0) name else "$stem ($n)$extension"
    }

    fun chooseName(original: String, exists: (String) -> Boolean): String {
        for (suffix in 0..99999) {
            val candidate = renamed(original, suffix)
            if (!exists(candidate)) return candidate
        }
        throw IOException("Too many filename conflicts")
    }
}

class PhoneInbox(private val resolver: ContentResolver) {
    private val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    private fun exists(directory: String, name: String): Boolean = resolver.query(
        collection, arrayOf(MediaStore.Downloads._ID),
        "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.DISPLAY_NAME}=?",
        arrayOf(directory, name), null
    )?.use { it.moveToFirst() } ?: false

    fun save(file: IncomingFile, input: InputStream): String {
        require(file.size in 0..(64L * 1024 * 1024 * 1024) && Regex("[a-f0-9]{64}").matches(file.sha256)) { "Invalid file metadata" }
        val directory = PhoneInboxPath.directory(file.relativePath)
        val original = PhoneInboxPath.name(file.relativePath)
        val name = PhoneInboxPath.chooseName(original) { exists(directory, it) }
        val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        val mimeType = PhoneInboxPath.imageMimeType(name)
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.RELATIVE_PATH, directory)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri: Uri = resolver.insert(collection, values) ?: throw IOException("Cannot create Downloads file")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            var count = 0L
            (resolver.openOutputStream(uri, "w") ?: throw IOException("Cannot write Downloads file")).use { output ->
                val buffer = ByteArray(256 * 1024)
                while (count < file.size) {
                    val n = input.read(buffer, 0, minOf(buffer.size.toLong(), file.size - count).toInt())
                    if (n < 0) throw IOException("Incomplete transfer")
                    output.write(buffer, 0, n)
                    digest.update(buffer, 0, n)
                    count += n
                }
                output.flush()
            }
            if (digest.digest().joinToString("") { "%02x".format(it) } != file.sha256) throw IOException("File checksum mismatch")
            val committed = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            if (resolver.update(uri, committed, null, null) != 1) throw IOException("Cannot publish Downloads file")
            return name
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
    }
}
