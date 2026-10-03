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
    DELETE_FAILED,
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
                FileState.SELECTED -> setOf(FileState.QUEUED, FileState.ALREADY_PRESENT, FileState.SKIPPED)
                FileState.QUEUED -> setOf(FileState.SENDING)
                FileState.SENDING -> setOf(FileState.SENT, FileState.SKIPPED, FileState.TRANSFER_FAILED)
                FileState.SENT -> setOf(FileState.VERIFYING, FileState.TRANSFER_FAILED)
                FileState.VERIFYING -> setOf(FileState.COMMITTED, FileState.ALREADY_PRESENT)
                FileState.COMMITTED, FileState.ALREADY_PRESENT -> setOf(FileState.COPIED, FileState.DELETING_SOURCE)
                FileState.DELETING_SOURCE -> setOf(FileState.MOVED, FileState.DELETE_FAILED)
                else -> emptySet()
            }
        require(next in allowed) { "Invalid transfer transition: $state → $next" }
        state = next
    }
}
