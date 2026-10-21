package org.phonehaul.app

import android.net.Uri

enum class Disclosure { CAMERA, NOTIFICATIONS, MEDIA }

data class UiState(
    val screen: Screen = Screen.START,
    val disclosure: Disclosure? = null,
    val pairing: Pairing? = null,
    val selected: List<SourceItem> = emptyList(),
    val media: List<MediaEntry> = emptyList(),
    val mediaFilter: MediaFilter = MediaFilter.ALL,
    val mediaSort: MediaSort = MediaSort.LARGEST,
    val mediaChecked: Set<Uri> = emptySet(),
    val busy: Boolean = false,
    val error: String? = null,
    val status: String = "",
    val currentFile: String = "",
    val totalBytes: Long = 0L,
    val sentBytes: Long = 0L,
    val bytesPerSecond: Long = 0L,
    val committedCount: Int = 0,
    val processedCount: Int = 0,
    val currentFileProgress: Float = 0f,
    val movedCount: Int = 0,
    val freedBytes: Long = 0L,
    val skippedCount: Int = 0,
    val identicalCount: Int = 0,
    val deleteFailedCount: Int = 0,
    val cancelled: Boolean = false,
    val allowCancel: Boolean = false,
    val startedAt: Long = 0L,
)
