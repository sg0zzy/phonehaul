package org.phonehaul.app

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.StatFs
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

enum class Screen { START, DISCLOSE, SCAN, SELECT, MEDIA, REVIEW, PROGRESS, COMPLETE, ABOUT }

class PhoneHaulViewModel(
    application: Application,
) : AndroidViewModel(application) {
    var uiState by androidx.compose.runtime.mutableStateOf(UiState())
        private set

    private var client: ReceiverClient? = null
    private var transferJob: Job? = null
    private var activeTransfer: TransferRunner? = null
    private var inboxJob: Job? = null
    private var transferServiceStarted = false
    private var pendingDelete: CompletableDeferred<Boolean>? = null
    private var pendingAfterDisclosure: (() -> Unit)? = null
    val deleteRequests = Channel<List<Uri>>(Channel.BUFFERED)

    val fileCount get() = uiState.selected.size
    val folderCount get() =
        uiState.selected
            .mapNotNull { it.relativePath.substringBefore('/', "").takeIf(String::isNotEmpty) }
            .distinct()
            .size
    val selectedKnownBytes get() = uiState.selected.sumOf { it.size ?: 0L }
    val hasUnknownSizes get() = uiState.selected.any { it.size == null }
    val canMove get() = Selection.canMove(uiState.selected)
    val freeBytes get() =
        try {
            StatFs(getApplication<Application>().filesDir.path).availableBytes
        } catch (_: Exception) {
            0L
        }

    fun startScan() {
        uiState = uiState.copy(error = null, screen = Screen.SCAN)
    }

    fun openAbout() {
        uiState = uiState.copy(error = null, screen = Screen.ABOUT)
    }

    fun showDisclosure(
        disclosure: Disclosure,
        then: () -> Unit,
    ) {
        pendingAfterDisclosure = then
        uiState = uiState.copy(error = null, screen = Screen.DISCLOSE, disclosure = disclosure)
    }

    fun acceptDisclosure() {
        val then = pendingAfterDisclosure
        pendingAfterDisclosure = null
        uiState = uiState.copy(error = null, screen = Screen.START, disclosure = null)
        then?.invoke()
    }

    fun back() {
        if (!uiState.busy) {
            val screen =
                when (uiState.screen) {
                    Screen.SCAN -> Screen.START
                    Screen.MEDIA, Screen.REVIEW -> Screen.SELECT
                    Screen.SELECT -> Screen.START
                    Screen.ABOUT -> Screen.START
                    Screen.DISCLOSE -> Screen.START
                    else -> uiState.screen
                }
            pendingAfterDisclosure = null
            uiState = uiState.copy(error = null, screen = screen, disclosure = null)
        }
    }

    fun showError(message: String) {
        uiState = uiState.copy(error = message)
    }

    fun connect(raw: String) {
        val parsed =
            try {
                PairingParser.parse(raw)
            } catch (e: Exception) {
                uiState = uiState.copy(error = e.message)
                return
            }
        uiState = uiState.copy(busy = true, error = null, status = "Connecting to computer…")
        viewModelScope.launch {
            try {
                val candidate = ReceiverClient(getApplication<Application>().contentResolver, parsed)
                val supportsInbox = withContext(Dispatchers.IO) { candidate.connect() }
                client = candidate
                uiState = uiState.copy(pairing = parsed, selected = emptyList(), screen = Screen.SELECT)
                inboxJob?.cancel()
                if (supportsInbox) {
                    inboxJob =
                        viewModelScope.launch {
                            var consecutivePollFailures = 0
                            while (true) {
                                if (!uiState.busy) {
                                    try {
                                        val incoming = withContext(Dispatchers.IO) { candidate.nextIncoming() }
                                        consecutivePollFailures = 0
                                        if (incoming != null) {
                                            try {
                                                withContext(Dispatchers.IO) { candidate.receiveIncoming(incoming) }
                                                withContext(
                                                    Dispatchers.IO,
                                                ) { candidate.acknowledgeIncoming(incoming.id, "completed") }
                                                uiState = uiState.copy(error = null)
                                            } catch (e: Exception) {
                                                val error = "Could not receive ${incoming.relativePath}: ${e.message ?: "Unknown error"}"
                                                uiState = uiState.copy(error = error)
                                                runCatching {
                                                    withContext(
                                                        Dispatchers.IO,
                                                    ) { candidate.acknowledgeIncoming(incoming.id, "failed", e.message) }
                                                }
                                            }
                                        }
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (_: Exception) {
                                        if (!uiState.busy && client === candidate && ++consecutivePollFailures >= 3) {
                                            client = null
                                            inboxJob = null
                                            uiState =
                                                uiState.copy(
                                                    pairing = null,
                                                    selected = emptyList(),
                                                    error = "Connection to the computer was lost. Tap Scan PC QR to reconnect.",
                                                    screen = Screen.START,
                                                )
                                            return@launch
                                        }
                                    }
                                } else {
                                    consecutivePollFailures = 0
                                }
                                kotlinx.coroutines.delay(1000)
                            }
                        }
                }
            } catch (e: Exception) {
                uiState =
                    uiState.copy(
                        error =
                            when (e) {
                                is ReceiverHttpException ->
                                    if (e.statusCode == 401) {
                                        "Pairing QR expired or was replaced. Scan the current QR on the computer."
                                    } else {
                                        "Receiver rejected connection: ${e.message}"
                                    }
                                is SSLException ->
                                    "Secure connection failed. Scan a fresh QR. ${e.message.orEmpty()}"
                                is ConnectException,
                                is NoRouteToHostException,
                                is SocketTimeoutException,
                                is UnknownHostException,
                                ->
                                    "Unable to reach ${parsed.label}. Check that PhoneHaul Receiver is running, " +
                                        "both devices are on the same local network, and the computer firewall allows " +
                                        "the receiver port. ${e.message.orEmpty()}"
                                else -> "Could not connect to ${parsed.label}: ${e.message.orEmpty()}"
                            },
                        screen = Screen.START,
                    )
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    fun addDocuments(uris: List<Uri>) {
        if (uris.isEmpty()) return
        uiState = uiState.copy(busy = true, error = null, status = "Reading selected files…")
        viewModelScope.launch {
            try {
                val additions =
                    withContext(Dispatchers.IO) {
                        Selection.addDocuments(getApplication<Application>(), uris, uiState.selected)
                    }
                uiState = uiState.copy(selected = uiState.selected + additions)
            } catch (e: Exception) {
                uiState = uiState.copy(error = e.message)
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    fun addTree(uri: Uri) {
        uiState = uiState.copy(busy = true, error = null, status = "Counting files in selected folder…")
        viewModelScope.launch {
            try {
                val additions =
                    withContext(Dispatchers.IO) {
                        Selection.addTree(getApplication<Application>(), uri, uiState.selected)
                    }
                uiState = uiState.copy(selected = uiState.selected + additions)
            } catch (e: Exception) {
                uiState = uiState.copy(error = e.message)
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    fun removeTopLevel(name: String) {
        uiState =
            uiState.copy(
                selected = uiState.selected.filterNot { it.relativePath.substringBefore('/') == name },
            )
    }

    fun clearSelection() {
        uiState = uiState.copy(selected = emptyList())
    }

    fun review() {
        if (uiState.selected.isNotEmpty()) {
            uiState = uiState.copy(error = null, screen = Screen.REVIEW)
        }
    }

    fun openMedia() {
        uiState = uiState.copy(screen = Screen.MEDIA)
        loadMedia()
    }

    fun changeMediaFilter(value: MediaFilter) {
        uiState = uiState.copy(mediaFilter = value)
        loadMedia()
    }

    fun changeMediaSort(value: MediaSort) {
        uiState = uiState.copy(mediaSort = value)
        loadMedia()
    }

    fun loadMedia() {
        uiState = uiState.copy(busy = true, error = null)
        viewModelScope.launch {
            try {
                uiState =
                    uiState.copy(
                        media =
                            withContext(Dispatchers.IO) {
                                MediaRepository.query(getApplication<Application>(), uiState.mediaFilter, uiState.mediaSort)
                            },
                    )
            } catch (e: Exception) {
                uiState = uiState.copy(error = "Unable to read photos and videos: ${e.message}")
            } finally {
                uiState = uiState.copy(busy = false)
            }
        }
    }

    fun toggleMedia(uri: Uri) {
        uiState =
            uiState.copy(
                mediaChecked = if (uri in uiState.mediaChecked) uiState.mediaChecked - uri else uiState.mediaChecked + uri,
            )
    }

    fun selectAllMedia() {
        uiState = uiState.copy(mediaChecked = uiState.media.map { it.source.uri }.toSet())
    }

    fun addCheckedMedia() {
        val used = uiState.selected.map { it.relativePath }.toMutableSet()
        val additions =
            uiState.media
                .filter { it.source.uri in uiState.mediaChecked && uiState.selected.none { s -> s.uri == it.source.uri } }
                .map { entry ->
                    val source = entry.source
                    val name = Names.uniqueName(source.relativePath, { it in used })
                    used += name
                    source.copy(relativePath = name)
                }
        uiState =
            uiState.copy(
                selected = uiState.selected + additions,
                mediaChecked = emptySet(),
                screen = Screen.SELECT,
            )
    }

    fun onDeleteResult(approved: Boolean) {
        pendingDelete?.complete(approved)
    }

    private suspend fun confirmMediaDelete(uris: List<Uri>): Boolean {
        if (uris.isEmpty()) return true
        val result = CompletableDeferred<Boolean>()
        pendingDelete = result
        return try {
            deleteRequests.send(uris)
            result.await()
        } finally {
            if (pendingDelete === result) pendingDelete = null
        }
    }

    fun startTransfer(mode: TransferMode) {
        if (uiState.selected.isEmpty() || uiState.busy || mode == TransferMode.MOVE && !canMove) return
        val receiver = client ?: return
        val application = getApplication<Application>()
        try {
            application.startForegroundService(Intent(application, TransferService::class.java))
            transferServiceStarted = true
        } catch (e: Exception) {
            uiState = uiState.copy(error = "Could not start background transfer: ${e.message ?: "Unknown error"}")
            return
        }
        uiState =
            uiState.copy(
                busy = true,
                allowCancel = true,
                error = null,
                screen = Screen.PROGRESS,
                status = "Checking selected files…",
                currentFile = "",
                totalBytes = selectedKnownBytes,
                sentBytes = 0,
                bytesPerSecond = 0,
                committedCount = 0,
                processedCount = 0,
                currentFileProgress = 0f,
                movedCount = 0,
                freedBytes = 0,
                skippedCount = 0,
                identicalCount = 0,
                deleteFailedCount = 0,
                cancelled = false,
                startedAt = System.currentTimeMillis(),
            )
        val batch = uiState.selected.toList()
        val runner =
            TransferRunner(
                application,
                receiver,
                mode,
                batch,
                readState = { uiState },
                writeState = { uiState = it },
                confirmMediaDelete = { uris -> confirmMediaDelete(uris) },
            )
        activeTransfer = runner
        transferJob =
            viewModelScope.launch {
                try {
                    runner.run()
                } finally {
                    transferServiceStarted = false
                    activeTransfer = null
                }
            }
    }

    override fun onCleared() {
        pendingDelete?.complete(false)
        if (transferServiceStarted) {
            getApplication<Application>().stopService(Intent(getApplication<Application>(), TransferService::class.java))
        }
        super.onCleared()
    }

    fun cancelTransfer() {
        if (!uiState.allowCancel) return
        val id = activeTransfer?.currentTransferId
        transferJob?.cancel()
        client?.cancelActive()
        if (id != null) {
            viewModelScope.launch(Dispatchers.IO) { runCatching { client?.cancel(id) } }
        }
    }

    fun newBatch() {
        if (!uiState.busy) {
            uiState = uiState.copy(selected = emptyList(), screen = Screen.SELECT, error = null)
        }
    }

    fun disconnect() {
        if (!uiState.busy) {
            inboxJob?.cancel()
            inboxJob = null
            client = null
            uiState = uiState.copy(pairing = null, selected = emptyList(), screen = Screen.START)
        }
    }
}
