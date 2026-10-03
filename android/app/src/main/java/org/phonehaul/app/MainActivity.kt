package org.phonehaul.app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val model: PhoneHaulViewModel by viewModels()
    private var cameraDenied by mutableStateOf(false)
    private var mediaDenied by mutableStateOf(false)
    private var pendingTransfer: TransferMode? = null

    private val filesPicker =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> model.addDocuments(uris) }
    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> uri?.let(model::addTree) }
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            pendingTransfer?.let { mode ->
                pendingTransfer = null
                model.startTransfer(mode)
            }
        }
    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            cameraDenied = !granted
            if (granted) model.startScan()
        }
    private val mediaPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            mediaDenied = result.values.none { it }
            if (!mediaDenied) model.openMedia()
        }
    private val deleteLauncher =
        registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            model.onDeleteResult(result.resultCode == Activity.RESULT_OK)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                model.deleteRequests.receiveAsFlow().collect { uris ->
                    try {
                        val request = MediaStore.createDeleteRequest(contentResolver, uris)
                        deleteLauncher.launch(IntentSenderRequest.Builder(request.intentSender).build())
                    } catch (_: Exception) {
                        model.onDeleteResult(false)
                    }
                }
            }
        }
        setContent {
            MaterialTheme {
                BackHandler(enabled = model.busy || model.screen != Screen.START) {
                    if (!model.busy) model.back()
                }
                App(model, cameraDenied, mediaDenied, ::requestScan, ::requestMedia, {
                    filesPicker.launch(arrayOf("*/*"))
                }, { folderPicker.launch(null) }, ::requestTransfer)
            }
        }
    }

    private fun requestTransfer(mode: TransferMode) {
        val preferences = getSharedPreferences("phonehaul_ui", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !preferences.getBoolean("notification_permission_requested", false)
        ) {
            pendingTransfer = mode
            preferences.edit().putBoolean("notification_permission_requested", true).apply()
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            model.startTransfer(mode)
        }
    }

    private fun requestScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            model.startScan()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun requestMedia() {
        val permissions =
            if (Build.VERSION.SDK_INT >=
                34
            ) {
                arrayOf(
                    Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
                )
            } else if (Build.VERSION.SDK_INT >= 33) {
                arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
            } else {
                arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        if (permissions.any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) {
            model.openMedia()
        } else {
            mediaPermissions.launch(permissions)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun App(
    vm: PhoneHaulViewModel,
    cameraDenied: Boolean,
    mediaDenied: Boolean,
    requestScan: () -> Unit,
    requestMedia: () -> Unit,
    selectFiles: () -> Unit,
    selectFolder: () -> Unit,
    startTransfer: (TransferMode) -> Unit,
) {
    Scaffold(topBar = {
        TopAppBar(title = { Text("PhoneHaul") }, navigationIcon = {
            if (vm.screen != Screen.START &&
                vm.screen != Screen.PROGRESS &&
                vm.screen != Screen.COMPLETE
            ) {
                TextButton(onClick = vm::back) { Text("Back") }
            }
        })
    }) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (vm.screen) {
                Screen.START -> {
                    Heading("Move files from your phone to your computer.")
                    Text("PhoneHaul works only when your phone and computer are connected to the same local network.")
                    Button(onClick = requestScan, modifier = Modifier.fillMaxWidth()) { Text("Scan PC QR") }
                    if (cameraDenied) {
                        Text(
                            "Camera permission is needed to scan the QR code. You can allow it in Android settings.",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    Text("Launch PhoneHaul Receiver on your computer to display the QR code.")
                }
                Screen.SCAN -> {
                    Heading("Scan the computer QR")
                    QrScanner(onFound = vm::connect, onError = { vm.showError(it) })
                    if (vm.busy) Text(vm.status)
                }
                Screen.SELECT -> {
                    Heading("Connected to ${vm.pairing?.label.orEmpty()}")
                    Text("Phone free space: ${formatBytes(vm.freeBytes)}")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = selectFiles, enabled = !vm.busy) { Text("Select files") }
                        OutlinedButton(onClick = selectFolder, enabled = !vm.busy) { Text("Select folder") }
                    }
                    OutlinedButton(onClick = requestMedia, enabled = !vm.busy) { Text("Photos & videos") }
                    if (mediaDenied) {
                        Text(
                            "Allow photo and video access to browse media, or use Select files.",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    if (vm.busy) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 3.dp)
                            Text(vm.status.ifEmpty { "Reading selection…" })
                        }
                    }
                    SelectedSummary(vm)
                    if (vm.selected.isNotEmpty()) {
                        val selectionGroups =
                            remember(vm.selected) { vm.selected.groupBy { it.relativePath.substringBefore('/') }.toList() }
                        TextButton(onClick = vm::clearSelection, enabled = !vm.busy) { Text("Clear selection") }
                        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            items(selectionGroups, key = { it.first }) { (name, files) ->
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        if (files.any { '/' in it.relativePath }) "$name/ (${files.size} files)" else name,
                                        Modifier.weight(1f),
                                    )
                                    TextButton(onClick = { vm.removeTopLevel(name) }, enabled = !vm.busy) { Text("Remove") }
                                }
                            }
                        }
                        Button(onClick = vm::review, modifier = Modifier.fillMaxWidth(), enabled = !vm.busy) { Text("Continue") }
                    }
                    TextButton(onClick = vm::disconnect, enabled = !vm.busy) { Text("Disconnect") }
                }
                Screen.MEDIA -> {
                    Heading("Photos & videos")
                    var previewUri by remember { mutableStateOf<Uri?>(null) }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        MediaFilter.entries.forEach { filter ->
                            FilterChip(selected = vm.mediaFilter == filter, onClick = {
                                vm.changeMediaFilter(filter)
                            }, label = { Text(filter.name.lowercase().replaceFirstChar(Char::uppercase)) })
                        }
                    }
                    OutlinedButton(onClick = {
                        vm.changeMediaSort(MediaSort.entries[(vm.mediaSort.ordinal + 1) % MediaSort.entries.size])
                    }) { Text("Sort: ${vm.mediaSort.name.lowercase().replaceFirstChar(Char::uppercase)}") }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${vm.mediaChecked.size} selected", Modifier.weight(1f))
                        TextButton(onClick = vm::selectAllMedia) { Text("Select all") }
                    }
                    if (vm.busy) Text("Reading media…")
                    LazyColumn(Modifier.weight(1f)) {
                        items(vm.media, key = { it.source.uri.toString() }) { entry ->
                            val item = entry.source
                            Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = item.uri in vm.mediaChecked, onCheckedChange = { vm.toggleMedia(item.uri) })
                                MediaThumbnail(item.uri, entry.isVideo, onClick = { previewUri = item.uri })
                                Spacer(Modifier.width(8.dp))
                                Column(Modifier.weight(1f).clickable { vm.toggleMedia(item.uri) }) {
                                    Text(item.relativePath)
                                    Text(
                                        "${formatBytes(item.size ?: 0)} · ${if (entry.isVideo) "Video" else "Photo"}",
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                    Button(onClick = vm::addCheckedMedia, modifier = Modifier.fillMaxWidth(), enabled = vm.mediaChecked.isNotEmpty()) {
                        Text("Add selected media")
                    }
                    previewUri?.let { uri ->
                        val isVideo = vm.media.firstOrNull { it.source.uri == uri }?.isVideo == true
                        MediaPreview(uri, isVideo, onDismiss = { previewUri = null })
                    }
                }
                Screen.REVIEW -> {
                    Heading("Ready to transfer")
                    SelectedSummary(vm)
                    Text("Destination: ${vm.pairing?.label.orEmpty()}")
                    Text("Phone free space: ${formatBytes(vm.freeBytes)}")
                    Text("Transfers can continue with the screen off. Android may ask to show a transfer notification.")
                    if (!vm.hasUnknownSizes) Text("After MOVE: approximately ${formatBytes(vm.freeBytes + vm.selectedKnownBytes)} free")
                    Button(onClick = {
                        startTransfer(TransferMode.MOVE)
                    }, modifier = Modifier.fillMaxWidth(), enabled = vm.canMove) { Text("MOVE — Free space") }
                    Text("Delete each source only after the receiver commits it. Photos and videos may need Android confirmation.")
                    if (!vm.canMove) {
                        Text(
                            "Some selected files cannot be deleted by Android. Choose COPY or remove those files.",
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                    OutlinedButton(
                        onClick = { startTransfer(TransferMode.COPY) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("COPY — Keep originals") }
                }
                Screen.PROGRESS -> {
                    Heading(vm.status)
                    Text("${vm.processedCount} of ${vm.fileCount} files processed · ${vm.committedCount} new copies")
                    LinearProgressIndicator(progress = {
                        if (vm.fileCount >
                            0
                        ) {
                            ((vm.processedCount + vm.currentFileProgress) / vm.fileCount).coerceIn(0f, 1f)
                        } else {
                            0f
                        }
                    }, modifier = Modifier.fillMaxWidth())
                    Text("${formatBytes(vm.sentBytes)} sent · ${formatBytes(vm.totalBytes)} selected")
                    Text("${formatBytes(vm.bytesPerSecond)}/s · ${((System.currentTimeMillis() - vm.startedAt) / 1000).coerceAtLeast(0)} s")
                    if (vm.currentFile.isNotEmpty()) Text("Current: ${vm.currentFile}")
                    if (vm.movedCount > 0) Text("${formatBytes(vm.freedBytes)} freed so far")
                    if (vm.allowCancel) OutlinedButton(onClick = vm::cancelTransfer) { Text("Cancel") }
                }
                Screen.COMPLETE -> {
                    Heading(vm.status)
                    Text("${vm.committedCount} new files received")
                    if (vm.identicalCount > 0) Text("${vm.identicalCount} identical files already existed at the destination")
                    Text("${vm.movedCount} originals removed · ${formatBytes(vm.freedBytes)} freed")
                    if (vm.skippedCount > 0) Text("${vm.skippedCount} skipped files remain on phone")
                    if (vm.folderCount > 0) Text("Source folders remain on phone.")
                    if (vm.deleteFailedCount >
                        0
                    ) {
                        Text("${vm.deleteFailedCount} originals could not be removed. Their computer copies remain intact.")
                    }
                    if (vm.cancelled) Text("Uncommitted files remain on your phone.")
                    Button(onClick = vm::newBatch, modifier = Modifier.fillMaxWidth()) { Text("Select more files") }
                    OutlinedButton(onClick = vm::disconnect) { Text("Done") }
                }
            }
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
}

@Composable private fun SelectedSummary(vm: PhoneHaulViewModel) {
    Text(
        "Selected: ${vm.fileCount} files · ${vm.folderCount} folders · ${formatBytes(
            vm.selectedKnownBytes,
        )}${if (vm.hasUnknownSizes) " + unknown sizes" else ""}",
    )
}

@Composable
private fun MediaThumbnail(
    uri: Uri,
    isVideo: Boolean,
    onClick: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val bitmap by produceState<android.graphics.Bitmap?>(initialValue = null, uri) {
        value =
            withContext(Dispatchers.IO) {
                try {
                    context.contentResolver.loadThumbnail(uri, Size(144, 144), null)
                } catch (
                    e: CancellationException,
                ) {
                    throw e
                } catch (_: Exception) {
                    null
                }
            }
    }
    Box(
        Modifier
            .size(
                56.dp,
            ).clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap !=
            null
        ) {
            Image(
                bitmap!!.asImageBitmap(),
                contentDescription = if (isVideo) "Video preview" else "Photo preview",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(if (isVideo) "▶" else "▧", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MediaPreview(
    uri: Uri,
    isVideo: Boolean,
    onDismiss: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val bitmap by produceState<android.graphics.Bitmap?>(initialValue = null, uri) {
        value =
            withContext(Dispatchers.IO) {
                try {
                    if (isVideo) {
                        context.contentResolver.loadThumbnail(uri, Size(480, 480), null)
                    } else {
                        val source = ImageDecoder.createSource(context.contentResolver, uri)
                        ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                            val screen = context.resources.displayMetrics
                            val scale =
                                minOf(
                                    1f,
                                    screen.widthPixels.toFloat() / info.size.width,
                                    screen.heightPixels.toFloat() / info.size.height,
                                )
                            decoder.setTargetSize(
                                (info.size.width * scale).toInt().coerceAtLeast(1),
                                (info.size.height * scale).toInt().coerceAtLeast(1),
                            )
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null
                }
            }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black).clickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            if (bitmap !=
                null
            ) {
                Image(
                    bitmap!!.asImageBitmap(),
                    contentDescription = "Full-screen media preview",
                    modifier = Modifier.fillMaxWidth(),
                    contentScale = ContentScale.Fit,
                )
            } else {
                Text("Preview unavailable", color = androidx.compose.ui.graphics.Color.White)
            }
        }
    }
}

private fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var index = -1
    do {
        value /= 1024
        index++
    } while (value >= 1024 && index < units.lastIndex)
    return "%.1f %s".format(value, units[index])
}
