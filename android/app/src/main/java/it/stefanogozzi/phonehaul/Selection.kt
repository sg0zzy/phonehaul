package org.phonehaul.app

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import java.util.UUID

enum class DeleteCapability { DIRECT, CONFIRMATION, READ_ONLY }

data class SourceItem(
    val id: String = UUID.randomUUID().toString(),
    val uri: Uri,
    val relativePath: String,
    val size: Long?,
    val modified: Long?,
    val deleteCapability: DeleteCapability,
)

object Selection {
    private fun capability(
        resolver: ContentResolver,
        uri: Uri,
    ): DeleteCapability =
        try {
            resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() &&
                    cursor.getInt(0) and DocumentsContract.Document.FLAG_SUPPORTS_DELETE != 0
                ) {
                    DeleteCapability.DIRECT
                } else {
                    DeleteCapability.READ_ONLY
                }
            } ?: DeleteCapability.READ_ONLY
        } catch (_: Exception) {
            DeleteCapability.READ_ONLY
        }

    fun addDocuments(
        context: Context,
        uris: List<Uri>,
        existing: List<SourceItem>,
    ): List<SourceItem> {
        val used = existing.map { it.relativePath.substringBefore('/') }.toMutableSet()
        val result = mutableListOf<SourceItem>()
        for (uri in uris.distinct()) {
            if (existing.any { it.uri == uri }) continue
            val document = DocumentFile.fromSingleUri(context, uri) ?: continue
            val name = Names.uniqueName(Names.safeName(document.name ?: "unnamed"), { it in used })
            used += name
            result +=
                SourceItem(
                    uri = uri,
                    relativePath = name,
                    size = document.length().takeIf { it >= 0 },
                    modified =
                        document.lastModified().takeIf {
                            it >
                                0
                        },
                    deleteCapability = capability(context.contentResolver, uri),
                )
        }
        return result
    }

    fun addTree(
        context: Context,
        uri: Uri,
        existing: List<SourceItem>,
    ): List<SourceItem> {
        val root = DocumentFile.fromTreeUri(context, uri) ?: throw IllegalArgumentException("Unable to read selected folder")
        require(root.isDirectory) { "Selected item is not a folder" }
        val used = existing.map { it.relativePath.substringBefore('/') }.toSet()
        val rootName = Names.uniqueName(Names.safeName(root.name ?: "Folder"), { it in used })
        val result = mutableListOf<SourceItem>()
        val resolver = context.contentResolver
        val treeId = DocumentsContract.getTreeDocumentId(uri)
        var visited = 0

        fun visit(
            documentId: String,
            relative: String,
            depth: Int,
        ) {
            require(depth < 100) { "Folder is too large or deeply nested" }
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, documentId)
            val projection =
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                    DocumentsContract.Document.COLUMN_FLAGS,
                )
            val cursor =
                resolver.query(childrenUri, projection, null, null, null)
                    ?: throw IllegalArgumentException("Unable to read selected folder")
            cursor.use {
                val usedChildren = mutableSetOf<String>()
                while (it.moveToNext()) {
                    require(++visited <= 100_000) { "Folder is too large or deeply nested" }
                    val childId = it.getString(0)
                    val name = Names.uniqueName(Names.safeName(it.getString(1) ?: "unnamed"), { it in usedChildren })
                    usedChildren += name
                    val childPath = "$relative/$name"
                    if (it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                        visit(childId, childPath, depth + 1)
                    } else {
                        val childUri = DocumentsContract.buildDocumentUriUsingTree(uri, childId)
                        val flags = if (it.isNull(5)) 0 else it.getInt(5)
                        result +=
                            SourceItem(
                                uri = childUri,
                                relativePath = childPath,
                                size = if (it.isNull(3)) null else it.getLong(3).takeIf { size -> size >= 0 },
                                modified = if (it.isNull(4)) null else it.getLong(4).takeIf { time -> time > 0 },
                                deleteCapability =
                                    if (flags and DocumentsContract.Document.FLAG_SUPPORTS_DELETE !=
                                        0
                                    ) {
                                        DeleteCapability.DIRECT
                                    } else {
                                        DeleteCapability.READ_ONLY
                                    },
                            )
                    }
                }
            }
        }
        visit(treeId, rootName, 0)
        require(result.isNotEmpty()) { "Selected folder contains no files" }
        return result
    }

    fun mediaItem(
        id: Long,
        name: String,
        size: Long,
        modified: Long,
        isVideo: Boolean,
        relativeDirectory: String = "",
        volume: String = "external",
    ): SourceItem {
        val collection = if (isVideo) MediaStore.Video.Media.getContentUri(volume) else MediaStore.Images.Media.getContentUri(volume)
        val relative =
            (relativeDirectory.trim('/') + "/" + name)
                .trimStart('/')
                .split('/')
                .joinToString("/") { Names.safeName(it) }
        return SourceItem(
            uri = android.content.ContentUris.withAppendedId(collection, id),
            relativePath = relative,
            size = size,
            modified = modified,
            deleteCapability = DeleteCapability.CONFIRMATION,
        )
    }

    fun canMove(items: List<SourceItem>) = items.all { it.deleteCapability != DeleteCapability.READ_ONLY }
}
