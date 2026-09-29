package org.phonehaul.app

import android.content.Context
import android.provider.MediaStore

enum class MediaFilter { ALL, VIDEOS, PHOTOS, SCREENSHOTS }
enum class MediaSort { LARGEST, NEWEST, OLDEST, NAME }

data class MediaEntry(val source: SourceItem, val isVideo: Boolean, val isScreenshot: Boolean)

object MediaRepository {
    fun query(context: Context, filter: MediaFilter, sort: MediaSort): List<MediaEntry> {
        val result = mutableListOf<MediaEntry>()
        fun load(isVideo: Boolean) {
            val collection = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            val projection = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.RELATIVE_PATH)
            context.contentResolver.query(collection, projection, null, null, null)?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val dateIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                val pathIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.RELATIVE_PATH)
                while (cursor.moveToNext() && result.size < 20_000) {
                    val name = cursor.getString(nameIndex) ?: "unnamed"
                    val folder = cursor.getString(pathIndex) ?: ""
                    val screenshot = folder.contains("Screenshots", true) || name.contains("Screenshot", true)
                    if (filter == MediaFilter.SCREENSHOTS && !screenshot) continue
                    val size = cursor.getLong(sizeIndex)
                    val modified = cursor.getLong(dateIndex) * 1000L
                    result += MediaEntry(Selection.mediaItem(cursor.getLong(idIndex), name, size, modified, isVideo, folder), isVideo, screenshot)
                }
            }
        }
        if (filter != MediaFilter.PHOTOS && filter != MediaFilter.SCREENSHOTS) load(true)
        if (filter != MediaFilter.VIDEOS) load(false)
        val sorted = when (sort) {
            MediaSort.LARGEST -> result.sortedByDescending { it.source.size ?: 0L }
            MediaSort.NEWEST -> result.sortedByDescending { it.source.modified ?: 0L }
            MediaSort.OLDEST -> result.sortedBy { it.source.modified ?: 0L }
            MediaSort.NAME -> result.sortedBy { it.source.relativePath.lowercase() }
        }
        return sorted
    }
}
