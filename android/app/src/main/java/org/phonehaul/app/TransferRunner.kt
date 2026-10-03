package org.phonehaul.app

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * Executes one transfer batch on the main thread, driving [UiState] through
 * [writeState] and delegating phone-side deletion prompts to
 * [confirmMediaDelete].
 *
 * All per-transfer execution state (the active transfer id, the per-file
 * [FileTransition]s, and upload bookkeeping) is owned here so a new transfer
 * starts with a fresh, empty transfer.
 */
class TransferRunner(
    private val application: Application,
    private val client: ReceiverClient,
    private val mode: TransferMode,
    private val batch: List<SourceItem>,
    private val readState: () -> UiState,
    private val writeState: (UiState) -> Unit,
    private val confirmMediaDelete: suspend (List<Uri>) -> Boolean,
) {
    private var transferId: String? = null
    val currentTransferId: String? get() = transferId

    private val transitions = mutableMapOf<String, FileTransition>()
    private val uploaded = AtomicLong(0)

    private fun set(updater: (UiState) -> UiState) {
        writeState(updater(readState()))
    }

    /**
     * Runs the transfer to completion, or to cancellation. Never throws:
     * state is always left in a terminal screen, and the foreground service is
     * always stopped in the finally.
     */
    suspend fun run() {
        var sampleAt = System.nanoTime()
        var sampleBytes = 0L
        try {
            val files = batch
            val mediaCommitted = mutableListOf<PreparedFile>()
            for ((index, item) in files.withIndex()) {
                set { s ->
                    s.copy(
                        currentFile = item.relativePath,
                        status = "Starting file ${index + 1} of ${files.size}…",
                    )
                }
                val file =
                    if (item.size != null) {
                        PreparedFile(item, item.size, null)
                    } else {
                        set { s -> s.copy(status = "Checking size of file ${index + 1} of ${files.size}…") }
                        val (size, digest) = withContext(Dispatchers.IO) { client.hashAndSize(item.uri) }
                        PreparedFile(item, size, digest)
                    }
                if (item.size == null) set { s -> s.copy(totalBytes = s.totalBytes + file.size) }
                val disposition =
                    if (transferId == null) {
                        val plan =
                            withContext(Dispatchers.IO) {
                                client.createTransfer(listOf(item), mapOf(item.id to file), mode)
                            }
                        transferId = plan.transferId
                        plan.dispositions[item.id]
                    } else {
                        withContext(Dispatchers.IO) { client.appendFile(transferId!!, file) }
                    }
                val state = FileTransition()
                transitions[item.id] = state
                when (disposition) {
                    "already_present" -> {
                        state.to(FileState.ALREADY_PRESENT)
                        set { s -> s.copy(identicalCount = s.identicalCount + 1) }
                    }
                    "skipped" -> {
                        state.to(FileState.SKIPPED)
                        set { s ->
                            s.copy(
                                skippedCount = s.skippedCount + 1,
                                processedCount = s.processedCount + 1,
                            )
                        }
                        continue
                    }
                    "queued" -> {
                        state.to(FileState.QUEUED)
                        state.to(FileState.SENDING)
                        set { s -> s.copy(status = "Sending file ${index + 1} of ${files.size}…") }
                        var fileSent = 0L
                        val result =
                            try {
                                withContext(Dispatchers.IO) {
                                    client.upload(transferId!!, file) { n ->
                                        fileSent += n
                                        if (file.size > 0L) {
                                            set { s ->
                                                s.copy(
                                                    currentFileProgress =
                                                        (fileSent.toFloat() / file.size.toFloat()).coerceIn(0f, 1f),
                                                )
                                            }
                                        }
                                        val total = uploaded.addAndGet(n)
                                        set { s -> s.copy(sentBytes = total) }
                                        val now = System.nanoTime()
                                        if (now - sampleAt >= 500_000_000L) {
                                            set { s ->
                                                s.copy(
                                                    bytesPerSecond =
                                                        (
                                                            (total - sampleBytes) * 1_000_000_000L / (now - sampleAt)
                                                        ).coerceAtLeast(0),
                                                )
                                            }
                                            sampleAt = now
                                            sampleBytes = total
                                        }
                                    }
                                }
                            } catch (e: Exception) {
                                state.to(FileState.TRANSFER_FAILED)
                                throw e
                            }
                        if (result.status == "skipped") {
                            state.to(FileState.SKIPPED)
                            set { s ->
                                s.copy(
                                    skippedCount = s.skippedCount + 1,
                                    processedCount = s.processedCount + 1,
                                    currentFileProgress = 0f,
                                )
                            }
                            continue
                        }
                        state.to(FileState.SENT)
                        state.to(FileState.VERIFYING)
                        if (result.status == "already_present") {
                            state.to(FileState.ALREADY_PRESENT)
                            set { s -> s.copy(identicalCount = s.identicalCount + 1) }
                        } else {
                            state.to(FileState.COMMITTED)
                            set { s -> s.copy(committedCount = s.committedCount + 1) }
                        }
                    }
                    else -> throw IllegalStateException("Receiver returned no file disposition")
                }
                set { s -> s.copy(processedCount = s.processedCount + 1) }
                set { s -> s.copy(currentFileProgress = 0f) }
                if (mode == TransferMode.COPY) {
                    if (state.state == FileState.ALREADY_PRESENT || state.state == FileState.COMMITTED) {
                        state.to(FileState.COPIED)
                    }
                    continue
                }
                if (item.deleteCapability == DeleteCapability.CONFIRMATION) {
                    check(canDeleteSource(state.state)) { "Cannot request deletion before receiver verification" }
                    mediaCommitted += file
                    continue
                }
                check(canDeleteSource(state.state)) { "Cannot delete source before receiver verification" }
                state.to(FileState.DELETING_SOURCE)
                val deleted =
                    withContext(Dispatchers.IO) {
                        try {
                            DocumentsContract.deleteDocument(application.contentResolver, item.uri)
                        } catch (_: Exception) {
                            false
                        }
                    }
                if (deleted) {
                    state.to(FileState.MOVED)
                    set { s -> s.copy(movedCount = s.movedCount + 1, freedBytes = s.freedBytes + file.size) }
                } else {
                    state.to(FileState.DELETE_FAILED)
                    set { s -> s.copy(deleteFailedCount = s.deleteFailedCount + 1) }
                }
            }
            transferId?.let { id -> withContext(Dispatchers.IO) { client.finish(id) } }
            transferId = null
            set { s -> s.copy(allowCancel = false) }
            if (mode == TransferMode.MOVE && mediaCommitted.isNotEmpty()) {
                set { s -> s.copy(status = "Confirm deletion on phone…") }
                for (group in mediaCommitted.chunked(200)) {
                    val approved = confirmMediaDelete(group.map { it.source.uri })
                    for (file in group) {
                        val item = file.source
                        val state = transitions.getValue(item.id)
                        check(canDeleteSource(state.state)) { "Cannot delete source before receiver verification" }
                        state.to(FileState.DELETING_SOURCE)
                        if (approved) {
                            state.to(FileState.MOVED)
                            set { s -> s.copy(movedCount = s.movedCount + 1, freedBytes = s.freedBytes + file.size) }
                        } else {
                            state.to(FileState.DELETE_FAILED)
                            set { s -> s.copy(deleteFailedCount = s.deleteFailedCount + 1) }
                        }
                    }
                }
            }
            set { s ->
                s.copy(
                    status =
                        if (s.deleteFailedCount > 0) {
                            "Files received; some originals could not be removed"
                        } else {
                            "Transfer complete"
                        },
                    screen = Screen.COMPLETE,
                )
            }
        } catch (_: CancellationException) {
            set { s -> s.copy(cancelled = true, status = "Transfer cancelled", screen = Screen.COMPLETE) }
        } catch (e: Exception) {
            set { s ->
                s.copy(
                    error = e.message ?: "Transfer failed",
                    status = "Transfer stopped; uncommitted files remain on phone",
                    screen = Screen.COMPLETE,
                )
            }
            transferId?.let { id -> runCatching { withContext(Dispatchers.IO) { client.cancel(id) } } }
        } finally {
            set { s -> s.copy(busy = false, allowCancel = false, currentFile = "") }
            transferId = null
            application.stopService(Intent(application, TransferService::class.java))
        }
    }
}
