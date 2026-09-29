package org.phonehaul.app

import org.junit.Assert.*
import org.junit.Test

class TransferStateTest {
    @Test fun moveRequiresCommitBeforeDeletion() {
        val file = FileTransition()
        assertThrows(IllegalArgumentException::class.java) { file.to(FileState.DELETING_SOURCE) }
        listOf(FileState.QUEUED, FileState.SENDING, FileState.SENT, FileState.VERIFYING, FileState.COMMITTED, FileState.DELETING_SOURCE, FileState.MOVED).forEach(file::to)
        assertEquals(FileState.MOVED, file.state)
    }

    @Test fun deletionFailureKeepsCommittedDestinationState() {
        val file = FileTransition()
        listOf(FileState.QUEUED, FileState.SENDING, FileState.SENT, FileState.VERIFYING, FileState.COMMITTED, FileState.DELETING_SOURCE, FileState.DELETE_FAILED).forEach(file::to)
        assertEquals(FileState.DELETE_FAILED, file.state)
    }

    @Test fun copyNeverEntersSourceDeletion() {
        val file = FileTransition()
        listOf(FileState.QUEUED, FileState.SENDING, FileState.SENT, FileState.VERIFYING, FileState.COMMITTED, FileState.COPIED).forEach(file::to)
        assertEquals(FileState.COPIED, file.state)
        assertThrows(IllegalArgumentException::class.java) { file.to(FileState.DELETING_SOURCE) }
    }

}
