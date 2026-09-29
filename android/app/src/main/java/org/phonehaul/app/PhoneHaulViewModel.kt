package org.phonehaul.app

import android.app.Application
import android.net.Uri
import android.os.StatFs
import android.provider.DocumentsContract
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

enum class Screen { START, SCAN, SELECT, MEDIA, REVIEW, PROGRESS, COMPLETE }

class PhoneHaulViewModel(application: Application) : AndroidViewModel(application) {
    var screen by androidx.compose.runtime.mutableStateOf(Screen.START)
        private set
    var pairing by androidx.compose.runtime.mutableStateOf<Pairing?>(null)
        private set
    var selected by androidx.compose.runtime.mutableStateOf<List<SourceItem>>(emptyList())
        private set
    var media by androidx.compose.runtime.mutableStateOf<List<MediaEntry>>(emptyList())
        private set
    var mediaFilter by androidx.compose.runtime.mutableStateOf(MediaFilter.ALL)
        private set
    var mediaSort by androidx.compose.runtime.mutableStateOf(MediaSort.LARGEST)
        private set
    var mediaChecked by androidx.compose.runtime.mutableStateOf<Set<Uri>>(emptySet())
        private set
    var busy by androidx.compose.runtime.mutableStateOf(false)
        private set
    var error by androidx.compose.runtime.mutableStateOf<String?>(null)
        private set
    var status by androidx.compose.runtime.mutableStateOf("")
        private set
    var currentFile by androidx.compose.runtime.mutableStateOf("")
        private set
    var totalBytes by androidx.compose.runtime.mutableLongStateOf(0L)
        private set
    var sentBytes by androidx.compose.runtime.mutableLongStateOf(0L)
        private set
    var bytesPerSecond by androidx.compose.runtime.mutableLongStateOf(0L)
        private set
    var committedCount by androidx.compose.runtime.mutableIntStateOf(0)
        private set
    var movedCount by androidx.compose.runtime.mutableIntStateOf(0)
        private set
    var freedBytes by androidx.compose.runtime.mutableLongStateOf(0L)
        private set
    var skippedCount by androidx.compose.runtime.mutableIntStateOf(0)
        private set
    var identicalCount by androidx.compose.runtime.mutableIntStateOf(0)
        private set
    var deleteFailedCount by androidx.compose.runtime.mutableIntStateOf(0)
        private set
    var cancelled by androidx.compose.runtime.mutableStateOf(false)
        private set
    var allowCancel by androidx.compose.runtime.mutableStateOf(false)
        private set
    var startedAt by androidx.compose.runtime.mutableLongStateOf(0L)
        private set

    private var client: ReceiverClient? = null
    private var transferId: String? = null
    private var transferJob: Job? = null
    private val transitions = mutableMapOf<String, FileTransition>()

    val fileCount get() = selected.count { !it.isDirectory }
    val folderCount get() = selected.count { it.isDirectory }
    val selectedKnownBytes get() = selected.filterNot { it.isDirectory }.sumOf { it.size ?: 0L }
    val hasUnknownSizes get() = selected.any { !it.isDirectory && it.size == null }
    val canMove get() = Selection.canMove(selected)
    val freeBytes get() = try { StatFs(getApplication<Application>().filesDir.path).availableBytes } catch (_: Exception) { 0L }

    fun startScan() { error = null; screen = Screen.SCAN }
    fun back() { if (!busy) { error = null; screen = when (screen) { Screen.SCAN -> Screen.START; Screen.MEDIA, Screen.REVIEW -> Screen.SELECT; Screen.SELECT -> Screen.START; else -> screen } } }
    fun clearError() { error = null }
    fun showError(message: String) { error = message }

    fun connect(raw: String) {
        val parsed = try { PairingParser.parse(raw) } catch (e: Exception) { error = e.message; return }
        busy = true; error = null; status = "Connecting to computer…"
        viewModelScope.launch {
            try {
                val candidate = ReceiverClient(getApplication<Application>().contentResolver, parsed)
                withContext(Dispatchers.IO) { candidate.connect() }
                client = candidate; pairing = parsed; selected = emptyList(); screen = Screen.SELECT
            } catch (e: Exception) {
                error = when (e) {
                    is ReceiverHttpException -> if (e.statusCode == 401) "Pairing QR expired or was replaced. Scan the current QR on the computer." else "Receiver rejected connection: ${e.message}"
                    is SSLException -> "Secure connection failed. Scan a fresh QR and check the computer's date and time. ${e.message.orEmpty()}"
                    is ConnectException, is NoRouteToHostException, is SocketTimeoutException, is UnknownHostException -> "Unable to reach ${parsed.label}. Check that PhoneHaul Receiver is running, both devices are on the same local network, and the computer firewall allows the receiver port. ${e.message.orEmpty()}"
                    else -> "Could not connect to ${parsed.label}: ${e.message.orEmpty()}"
                }
                screen = Screen.START
            }
            finally { busy = false }
        }
    }

    fun addDocuments(uris: List<Uri>) {
        if (uris.isEmpty()) return
        busy = true; error = null
        viewModelScope.launch {
            try { selected = selected + withContext(Dispatchers.IO) { Selection.addDocuments(getApplication(), uris, selected) } }
            catch (e: Exception) { error = e.message }
            finally { busy = false }
        }
    }

    fun addTree(uri: Uri) {
        busy = true; error = null; status = "Reading folder…"
        viewModelScope.launch {
            try { selected = selected + withContext(Dispatchers.IO) { Selection.addTree(getApplication(), uri, selected) } }
            catch (e: Exception) { error = e.message }
            finally { busy = false }
        }
    }

    fun remove(item: SourceItem) { selected = selected.filterNot { it.id == item.id || it.relativePath.startsWith(item.relativePath + "/") } }
    fun clearSelection() { selected = emptyList() }
    fun review() { if (selected.isNotEmpty()) { error = null; screen = Screen.REVIEW } }

    fun openMedia() { screen = Screen.MEDIA; loadMedia() }
    fun changeMediaFilter(value: MediaFilter) { mediaFilter = value; loadMedia() }
    fun changeMediaSort(value: MediaSort) { mediaSort = value; loadMedia() }
    fun loadMedia() {
        busy = true; error = null
        viewModelScope.launch {
            try { media = withContext(Dispatchers.IO) { MediaRepository.query(getApplication(), mediaFilter, mediaSort) } }
            catch (e: Exception) { error = "Unable to read photos and videos: ${e.message}" }
            finally { busy = false }
        }
    }
    fun toggleMedia(uri: Uri) { mediaChecked = if (uri in mediaChecked) mediaChecked - uri else mediaChecked + uri }
    fun selectAllMedia() { mediaChecked = media.map { it.source.uri }.toSet() }
    fun addCheckedMedia() {
        val used = selected.map { it.relativePath }.toMutableSet()
        val additions = media.filter { it.source.uri in mediaChecked && selected.none { s -> s.uri == it.source.uri } }.map { entry ->
            val source = entry.source
            val original = source.relativePath
            val dot = original.lastIndexOf('.')
            val stem = if (dot > 0) original.substring(0, dot) else original
            val extension = if (dot > 0) original.substring(dot) else ""
            var name = original; var n = 1
            while (name in used) { name = "$stem ($n)$extension"; n++ }
            used += name
            source.copy(relativePath = name)
        }
        selected = selected + additions
        mediaChecked = emptySet()
        screen = Screen.SELECT
    }

    fun startTransfer(mode: TransferMode, confirmMediaDelete: suspend (List<Uri>) -> Boolean) {
        if (selected.isEmpty() || busy || mode == TransferMode.MOVE && !canMove) return
        val receiver = client ?: return
        busy = true; allowCancel = true; error = null; screen = Screen.PROGRESS; status = "Checking selected files…"; currentFile = ""
        totalBytes = 0; sentBytes = 0; bytesPerSecond = 0; committedCount = 0; movedCount = 0; freedBytes = 0; skippedCount = 0; identicalCount = 0; deleteFailedCount = 0; cancelled = false; startedAt = System.currentTimeMillis()
        transitions.clear()
        val batch = selected.toList()
        val uploaded = AtomicLong(0)
        var sampleAt = System.nanoTime()
        var sampleBytes = 0L
        transferJob = viewModelScope.launch {
            try {
                val prepared = withContext(Dispatchers.IO) {
                    batch.filterNot { it.isDirectory }.associate { item ->
                        val (size, digest) = receiver.hashAndSize(item.uri)
                        item.id to PreparedFile(item, size, digest)
                    }
                }
                status = "Preparing transfer…"
                val plan = withContext(Dispatchers.IO) { receiver.createTransfer(batch, prepared, mode) }
                val id = plan.transferId
                transferId = id
                totalBytes = prepared.values.filter { plan.dispositions[it.source.id] == "queued" }.sumOf { it.size }
                val mediaCommitted = mutableListOf<SourceItem>()
                for (item in batch.filterNot { it.isDirectory }) {
                    val file = prepared.getValue(item.id)
                    currentFile = item.relativePath
                    val state = FileTransition()
                    transitions[item.id] = state
                    when (plan.dispositions[item.id]) {
                        "already_present" -> {
                            state.to(FileState.ALREADY_PRESENT)
                            identicalCount++
                        }
                        "skipped" -> {
                            state.to(FileState.SKIPPED)
                            skippedCount++
                            continue
                        }
                        "queued" -> {
                            state.to(FileState.QUEUED)
                            state.to(FileState.SENDING)
                            status = "Sending files…"
                            val result = try {
                                withContext(Dispatchers.IO) { receiver.upload(id, file) { n ->
                                    val total = uploaded.addAndGet(n)
                                    sentBytes = total
                                    val now = System.nanoTime()
                                    if (now - sampleAt >= 500_000_000L) {
                                        bytesPerSecond = ((total - sampleBytes) * 1_000_000_000L / (now - sampleAt)).coerceAtLeast(0)
                                        sampleAt = now; sampleBytes = total
                                    }
                                } }
                            } catch (e: Exception) { state.to(FileState.TRANSFER_FAILED); throw e }
                            if (result.status == "skipped") { state.to(FileState.SKIPPED); skippedCount++; continue }
                            state.to(FileState.SENT); state.to(FileState.VERIFYING); state.to(FileState.COMMITTED)
                            committedCount++
                        }
                        else -> throw IllegalStateException("Receiver returned no file disposition")
                    }
                    if (mode == TransferMode.COPY) {
                        if (state.state == FileState.ALREADY_PRESENT || state.state == FileState.COMMITTED) state.to(FileState.COPIED)
                        continue
                    }
                    if (item.deleteCapability == DeleteCapability.CONFIRMATION) {
                        mediaCommitted += item
                        continue
                    }
                    state.to(FileState.DELETING_SOURCE)
                    val deleted = withContext(Dispatchers.IO) { try { DocumentsContract.deleteDocument(getApplication<Application>().contentResolver, item.uri) } catch (_: Exception) { false } }
                    if (deleted) { state.to(FileState.MOVED); movedCount++; freedBytes += file.size }
                    else { state.to(FileState.DELETE_FAILED); deleteFailedCount++ }
                }
                withContext(Dispatchers.IO) { receiver.finish(id) }
                transferId = null
                allowCancel = false
                if (mode == TransferMode.MOVE && mediaCommitted.isNotEmpty()) {
                    status = "Confirm deletion on phone…"
                    for (group in mediaCommitted.chunked(200)) {
                        val approved = confirmMediaDelete(group.map { it.uri })
                        for (item in group) {
                            val state = transitions.getValue(item.id)
                            if (state.state == FileState.COMMITTED || state.state == FileState.ALREADY_PRESENT) state.to(FileState.DELETING_SOURCE)
                            if (approved) { state.to(FileState.MOVED); movedCount++; freedBytes += prepared.getValue(item.id).size }
                            else { state.to(FileState.DELETE_FAILED); deleteFailedCount++ }
                        }
                    }
                }
                status = if (deleteFailedCount > 0) "Files received; some originals could not be removed" else "Transfer complete"
                screen = Screen.COMPLETE
            } catch (_: CancellationException) {
                cancelled = true; status = "Transfer cancelled"; screen = Screen.COMPLETE
            } catch (e: Exception) {
                error = e.message ?: "Transfer failed"
                status = "Transfer stopped; uncommitted files remain on phone"
                screen = Screen.COMPLETE
                transferId?.let { id -> runCatching { withContext(Dispatchers.IO) { receiver.cancel(id) } } }
            } finally { busy = false; allowCancel = false; currentFile = ""; transferId = null }
        }
    }

    fun cancelTransfer() {
        if (!allowCancel) return
        val id = transferId
        transferJob?.cancel()
        client?.cancelActive()
        if (id != null) viewModelScope.launch(Dispatchers.IO) { runCatching { client?.cancel(id) } }
    }

    fun newBatch() { if (!busy) { selected = emptyList(); screen = Screen.SELECT; error = null } }
    fun disconnect() { if (!busy) { client = null; pairing = null; selected = emptyList(); screen = Screen.START } }
}
