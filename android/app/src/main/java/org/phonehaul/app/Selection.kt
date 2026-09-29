package org.phonehaul.app

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import java.util.UUID

enum class DeleteCapability { DIRECT, CONFIRMATION, READ_ONLY }
enum class SourceKind { DOCUMENT, MEDIA }

data class SourceItem(
    val id: String = UUID.randomUUID().toString(),
    val uri: Uri,
    val relativePath: String,
    val size: Long?,
    val modified: Long?,
    val isDirectory: Boolean,
    val deleteCapability: DeleteCapability,
    val kind: SourceKind = SourceKind.DOCUMENT
)

object Selection {
    private fun safeName(name: String): String {
        val cleaned = name.map { if (it == '/' || it == '\\' || it.code < 32) '_' else it }.joinToString("").trim()
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "unnamed" else cleaned
    }

    private fun uniqueTopLevel(name: String, used: Set<String>): String {
        if (name !in used) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val suffix = if (dot > 0) name.substring(dot) else ""
        var n = 1
        while ("$stem ($n)$suffix" in used) n++
        return "$stem ($n)$suffix"
    }

    private fun capability(resolver: ContentResolver, uri: Uri): DeleteCapability {
        return try {
            resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && cursor.getInt(0) and DocumentsContract.Document.FLAG_SUPPORTS_DELETE != 0) DeleteCapability.DIRECT else DeleteCapability.READ_ONLY
            } ?: DeleteCapability.READ_ONLY
        } catch (_: Exception) { DeleteCapability.READ_ONLY }
    }

    fun addDocuments(context: Context, uris: List<Uri>, existing: List<SourceItem>): List<SourceItem> {
        val used = existing.map { it.relativePath.substringBefore('/') }.toMutableSet()
        val result = mutableListOf<SourceItem>()
        for (uri in uris.distinct()) {
            if (existing.any { it.uri == uri }) continue
            val document = DocumentFile.fromSingleUri(context, uri) ?: continue
            val name = uniqueTopLevel(safeName(document.name ?: "unnamed"), used)
            used += name
            result += SourceItem(uri = uri, relativePath = name, size = document.length().takeIf { it >= 0 }, modified = document.lastModified().takeIf { it > 0 }, isDirectory = false, deleteCapability = capability(context.contentResolver, uri))
        }
        return result
    }

    fun addTree(context: Context, uri: Uri, existing: List<SourceItem>): List<SourceItem> {
        val root = DocumentFile.fromTreeUri(context, uri) ?: throw IllegalArgumentException("Unable to read selected folder")
        val used = existing.map { it.relativePath.substringBefore('/') }.toSet()
        val rootName = uniqueTopLevel(safeName(root.name ?: "Folder"), used)
        val result = mutableListOf<SourceItem>()
        fun visit(document: DocumentFile, relative: String, depth: Int) {
            require(depth < 100 && result.size < 100_000) { "Folder is too large or deeply nested" }
            val isDirectory = document.isDirectory
            result += SourceItem(uri = document.uri, relativePath = relative, size = if (isDirectory) null else document.length().takeIf { it >= 0 }, modified = document.lastModified().takeIf { it > 0 }, isDirectory = isDirectory, deleteCapability = capability(context.contentResolver, document.uri))
            if (isDirectory) {
                val usedChildren = mutableSetOf<String>()
                for (child in document.listFiles()) {
                    val name = uniqueTopLevel(safeName(child.name ?: "unnamed"), usedChildren)
                    usedChildren += name
                    visit(child, "$relative/$name", depth + 1)
                }
            }
        }
        visit(root, rootName, 0)
        return result
    }

    fun mediaItem(id: Long, name: String, size: Long, modified: Long, isVideo: Boolean, relativeDirectory: String = "", volume: String = "external"): SourceItem {
        val collection = if (isVideo) MediaStore.Video.Media.getContentUri(volume) else MediaStore.Images.Media.getContentUri(volume)
        val relative = (relativeDirectory.trim('/') + "/" + name).trimStart('/')
            .split('/').joinToString("/") { safeName(it) }
        return SourceItem(uri = android.content.ContentUris.withAppendedId(collection, id), relativePath = relative, size = size, modified = modified, isDirectory = false, deleteCapability = DeleteCapability.CONFIRMATION, kind = SourceKind.MEDIA)
    }

    fun canMove(items: List<SourceItem>) = items.filterNot { it.isDirectory }.all { it.deleteCapability != DeleteCapability.READ_ONLY }

}
