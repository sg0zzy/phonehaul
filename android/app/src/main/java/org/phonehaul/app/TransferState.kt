package org.phonehaul.app

enum class FileState {
    SELECTED,
    QUEUED,
    SENDING,
    SENT,
    VERIFYING,
    COMMITTED,
    ALREADY_PRESENT,
    DELETING_SOURCE,
    MOVED,
    COPIED,
    SKIPPED,
    TRANSFER_FAILED,
    VERIFY_FAILED,
    DELETE_FAILED,
    CANCELLED,
}

enum class TransferMode { COPY, MOVE }

fun canDeleteSource(state: FileState): Boolean = state == FileState.COMMITTED || state == FileState.ALREADY_PRESENT

class FileTransition(
    initial: FileState = FileState.SELECTED,
) {
    var state: FileState = initial
        private set

    fun to(next: FileState) {
        val allowed =
            when (state) {
                FileState.SELECTED -> setOf(FileState.QUEUED, FileState.ALREADY_PRESENT, FileState.SKIPPED, FileState.CANCELLED)
                FileState.QUEUED -> setOf(FileState.SENDING, FileState.CANCELLED)
                FileState.SENDING -> setOf(FileState.SENT, FileState.SKIPPED, FileState.TRANSFER_FAILED, FileState.CANCELLED)
                FileState.SENT -> setOf(FileState.VERIFYING, FileState.TRANSFER_FAILED)
                FileState.VERIFYING -> setOf(FileState.COMMITTED, FileState.ALREADY_PRESENT, FileState.VERIFY_FAILED)
                FileState.COMMITTED, FileState.ALREADY_PRESENT -> setOf(FileState.COPIED, FileState.DELETING_SOURCE)
                FileState.DELETING_SOURCE -> setOf(FileState.MOVED, FileState.DELETE_FAILED)
                else -> emptySet()
            }
        require(next in allowed) { "Invalid transfer transition: $state → $next" }
        state = next
    }
}
