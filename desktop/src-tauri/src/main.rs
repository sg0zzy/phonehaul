#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use parking_lot::Mutex;
use reqwest::{header, Body, Client};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, OnceLock},
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::io::ReaderStream;

struct Service {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    root: String,
    host: String,
    port: u16,
    error: Option<String>,
}
type Shared = Arc<Mutex<Service>>;

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("local HTTP client")
    })
}

#[cfg(debug_assertions)]
fn server_override() -> Option<PathBuf> {
    std::env::var_os("PHONEHAUL_SERVER_BIN").map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn server_override() -> Option<PathBuf> {
    None
}

fn drain_stdout<R, F>(reader: R, mut on_line: F) -> std::thread::JoinHandle<()>
where
    R: BufRead + Send + 'static,
    F: FnMut(String) + Send + 'static,
{
    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            on_line(line);
        }
    })
}
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

fn send_heartbeat<W: Write>(stdin: &mut W) -> std::io::Result<()> {
    stdin.write_all(b"heartbeat\n")?;
    stdin.flush()
}

// The sidecar stops when heartbeats stop arriving, so a supervisor killed
// without running its exit hook still takes the background service with it.
fn heartbeat_loop<W: Write + Send + 'static>(
    shared: Shared,
    mut stdin: W,
    interval: Duration,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        if shared.lock().child.is_none() {
            break;
        }
        if send_heartbeat(&mut stdin).is_err() {
            break;
        }
        std::thread::sleep(interval);
    })
}

#[derive(Serialize)]
struct ServerStatus {
    running: bool,
    host: String,
    port: u16,
    error: Option<String>,
}

fn stop(service: &mut Service) {
    if let Some(mut child) = service.child.take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}
fn running(service: &mut Service) -> bool {
    service
        .child
        .as_mut()
        .and_then(|c| c.try_wait().ok())
        .map(|s| s.is_none())
        .unwrap_or(false)
}
fn server_status(service: &mut Service) -> ServerStatus {
    let live = running(service);
    ServerStatus {
        running: live,
        host: service.host.clone(),
        port: service.port,
        error: service.error.clone(),
    }
}
fn launch(app: &tauri::AppHandle) -> Result<Service, String> {
    let bin = if let Some(path) = server_override() {
        path
    } else {
        let root = app.path().resource_dir().unwrap_or_default();
        #[cfg(target_os = "windows")]
        let executable = "phonehaul-server.exe";
        #[cfg(not(target_os = "windows"))]
        let executable = "phonehaul-server";
        [
            root.join(executable),
            root.join("resources").join(executable),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(executable)
        })
    };
    if !bin.is_file() {
        return Err(format!(
            "PhoneHaul server sidecar not found: {}",
            bin.display()
        ));
    }
    let mut command = Command::new(&bin);
    command
        .env("PHONEHAUL_DESKTOP_MANAGED", "1")
        .env("PHONEHAUL_NO_BROWSER", "1")
        .env("PHONEHAUL_TRANSFER_PORT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "windows")]
    {
        // The Node SEA is a console executable. Keep its console hidden when
        // launched from the Tauri window and silence its experimental SEA warning.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command.env("NODE_NO_WARNINGS", "1");
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start server: {e}"))?;
    let stdout = child.stdout.take().ok_or("Could not read server startup")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Could not write to server stdin")?;
    send_heartbeat(&mut stdin).map_err(|e| format!("Could not reach server stdin: {e}"))?;
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ =
                        ready_tx.send(Err("PhoneHaul server exited during startup".to_string()));
                    return;
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
                Ok(_) => {
                    if let Some(data) = line.strip_prefix("PHONEHAUL_READY ") {
                        let _ = ready_tx.send(Ok(data.to_string()));
                        break;
                    }
                    eprintln!("[PhoneHaul server] {}", line.trim_end());
                }
            }
        }
        // Continue consuming logs so the sidecar never blocks on a full stdout pipe.
        let _log_reader = drain_stdout(reader, |line| eprintln!("[PhoneHaul server] {line}"));
    });
    let ready_data = match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(data)) => data,
        Ok(Err(error)) => {
            let _ = child.wait();
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PhoneHaul server startup timed out".into());
        }
    };
    let ready: Value = serde_json::from_str(&ready_data).map_err(|e| e.to_string())?;
    let root = ready["uiUrl"]
        .as_str()
        .ok_or("Server startup response missing URL")?
        .trim_end_matches('/')
        .to_string();
    let host = ready["host"].as_str().unwrap_or("0.0.0.0").to_string();
    let port = ready["port"].as_u64().unwrap_or(0) as u16;
    Ok(Service {
        child: Some(child),
        stdin: Some(stdin),
        root,
        host,
        port,
        error: None,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::{
        drain_stdout, heartbeat_loop, stop, take_sse_events, Service, Shared, HEARTBEAT_INTERVAL,
    };
    use parking_lot::Mutex;
    use std::{
        io::{BufReader, Write},
        os::unix::net::UnixStream,
        process::Command,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    #[test]
    fn sidecar_stdout_is_drained_after_the_ready_line() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let read_count = Arc::new(AtomicUsize::new(0));
        let read_count_thread = read_count.clone();
        let reader_thread = drain_stdout(BufReader::new(reader), move |_| {
            read_count_thread.fetch_add(1, Ordering::Relaxed);
        });

        for i in 0..4096 {
            writeln!(writer, "server log line {i}").unwrap();
        }
        drop(writer);
        reader_thread.join().unwrap();

        assert_eq!(read_count.load(Ordering::Relaxed), 4096);
    }

    #[test]
    fn event_decoder_preserves_multibyte_text_split_across_chunks() {
        let payload = "data: {\"destination\":\"Café\"}\n\n";
        let bytes = payload.as_bytes();
        let split = bytes.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let mut buffer = Vec::new();
        assert!(take_sse_events(&mut buffer, &bytes[..split]).is_empty());
        let events = take_sse_events(&mut buffer, &bytes[split..]);
        assert_eq!(events[0]["destination"], "Café");
    }

    #[derive(Clone)]
    struct Recorder(Arc<Mutex<Vec<u8>>>);

    impl Write for Recorder {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn heartbeats(recorder: &Recorder) -> usize {
        let recorded = recorder.0.lock();
        String::from_utf8_lossy(&recorded)
            .lines()
            .filter(|line| *line == "heartbeat")
            .count()
    }

    #[test]
    fn heartbeat_loop_stops_before_writing_to_a_gone_sidecar() {
        let recorder = Recorder(Arc::new(Mutex::new(Vec::new())));
        let shared: Shared = Arc::new(Mutex::new(Service {
            child: None,
            stdin: None,
            root: String::new(),
            host: String::new(),
            port: 0,
            error: None,
        }));
        heartbeat_loop(shared, recorder.clone(), HEARTBEAT_INTERVAL)
            .join()
            .unwrap();
        assert_eq!(heartbeats(&recorder), 0);
    }

    #[test]
    fn heartbeat_loop_writes_periodically_and_stops_with_the_sidecar() {
        let recorder = Recorder(Arc::new(Mutex::new(Vec::new())));
        let shared: Shared = Arc::new(Mutex::new(Service {
            child: Some(Command::new("/bin/sleep").arg("30").spawn().unwrap()),
            stdin: None,
            root: String::new(),
            host: String::new(),
            port: 0,
            error: None,
        }));
        let handle = heartbeat_loop(shared.clone(), recorder.clone(), Duration::from_millis(200));

        // The first heartbeat is immediate; a second one proves the loop repeats.
        let deadline = Instant::now() + Duration::from_secs(2);
        while heartbeats(&recorder) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let written = heartbeats(&recorder);
        assert!(written >= 2, "expected periodic heartbeats, got {written}");

        // Stop while the loop is between writes: its next iteration sees no child,
        // so nothing is recorded after the sidecar is gone.
        stop(&mut shared.lock());
        handle.join().unwrap();
        assert_eq!(heartbeats(&recorder), written);
    }
}
async fn request_json(
    client: &Client,
    root: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut req = client
        .request(method, format!("{root}{path}"))
        .timeout(Duration::from_secs(10));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let response = req.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("PhoneHaul request failed")
            .to_string());
    }
    Ok(value)
}

async fn running_root(client: &Client, local_root: &str, lan_root: &str) -> bool {
    // Reachability check before issuing any command: the local root first,
    // then the LAN UI when that host is unavailable.
    if client
        .get(local_root)
        .send()
        .await
        .ok()
        .is_some_and(|response| response.status().is_success())
    {
        return true;
    }
    client
        .get(lan_root)
        .send()
        .await
        .ok()
        .is_some_and(|response| response.status().is_success())
}

#[tauri::command]
async fn get_status(service: State<'_, Shared>) -> Result<Value, String> {
    let (status, root) = {
        let mut s = service.lock();
        (server_status(&mut s), s.root.clone())
    };
    if !status.running {
        return Ok(json!({"server":status}));
    }
    let ui = request_json(http_client(), &root, reqwest::Method::GET, "/api/ui", None).await?;
    Ok(json!({"server":status,"ui":ui}))
}
#[tauri::command]
async fn refresh_qr(service: State<'_, Shared>) -> Result<(), String> {
    let (root, host, port) = {
        let s = service.lock();
        (s.root.clone(), s.host.clone(), s.port)
    };
    if !running_root(http_client(), &root, &format!("http://{}:{}", host, port)).await {
        return Err("PhoneHaul server is stopped".into());
    }
    request_json(
        http_client(),
        &root,
        reqwest::Method::POST,
        "/api/qr/refresh",
        None,
    )
    .await?;
    Ok(())
}
#[tauri::command]
async fn set_destination(app: tauri::AppHandle, service: State<'_, Shared>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |selection| {
        let _ = tx.send(selection);
    });
    let Some(selection) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let p = selection
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !p.is_dir() {
        return Err("Destination must be an existing directory".into());
    }
    let (root, host, port) = {
        let s = service.lock();
        (s.root.clone(), s.host.clone(), s.port)
    };
    if !running_root(http_client(), &root, &format!("http://{}:{}", host, port)).await {
        return Err("PhoneHaul server is stopped".into());
    }
    let client = http_client();
    let current = request_json(client, &root, reqwest::Method::GET, "/api/ui", None).await?;
    let conflict = current["settings"]["conflict"].as_str().unwrap_or("rename");
    request_json(
        client,
        &root,
        reqwest::Method::POST,
        "/api/settings",
        Some(json!({"destination":p.to_string_lossy(),"conflict":conflict})),
    )
    .await?;
    Ok(())
}
#[tauri::command]
async fn send_files(app: tauri::AppHandle, service: State<'_, Shared>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |selection| {
        let _ = tx.send(selection);
    });
    let Some(paths) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let paths = paths
        .into_iter()
        .map(|path| path.into_path().map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    queue_paths(&service, paths, false).await?;
    Ok(())
}

#[tauri::command]
async fn queue_dropped_paths(
    service: State<'_, Shared>,
    paths: Vec<PathBuf>,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Err("No files were dropped".into());
    }
    queue_paths(&service, paths, true).await
}

async fn queue_paths(
    service: &Shared,
    paths: Vec<PathBuf>,
    allow_directories: bool,
) -> Result<usize, String> {
    let (root, host, port) = {
        let service = service.lock();
        (service.root.clone(), service.host.clone(), service.port)
    };
    if !running_root(http_client(), &root, &format!("http://{}:{}", host, port)).await {
        return Err("PhoneHaul server is stopped".into());
    }

    let mut pending = paths
        .into_iter()
        .rev()
        .map(|path| (path, None::<PathBuf>))
        .collect::<Vec<_>>();
    let mut files = Vec::<(PathBuf, String)>::new();
    while let Some((path, relative_prefix)) = pending.pop() {
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| format!("Could not inspect {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Symbolic links cannot be sent: {}", path.display()));
        }

        if metadata.is_dir() {
            if !allow_directories {
                return Err(format!("Expected a file: {}", path.display()));
            }
            let directory_name = path
                .file_name()
                .ok_or_else(|| format!("Folder has no name: {}", path.display()))?;
            let relative_directory =
                relative_prefix.unwrap_or_else(|| PathBuf::from(directory_name));
            let mut entries = tokio::fs::read_dir(&path)
                .await
                .map_err(|e| format!("Could not read folder {}: {e}", path.display()))?;
            let mut children = Vec::new();
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|e| format!("Could not read folder {}: {e}", path.display()))?
            {
                children.push((entry.path(), entry.file_name()));
            }
            children.sort_by(|a, b| a.1.cmp(&b.1));
            for (child, name) in children.into_iter().rev() {
                pending.push((child, Some(relative_directory.join(name))));
            }
            continue;
        }

        if !metadata.is_file() {
            return Err(format!("Not a regular file: {}", path.display()));
        }
        let name = path
            .file_name()
            .ok_or_else(|| format!("File has no name: {}", path.display()))?;
        let relative = relative_prefix.unwrap_or_else(|| PathBuf::from(name));
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(format!("Invalid relative path for {}", path.display()));
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        let file_path = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| format!("Could not resolve {}: {e}", path.display()))?;
        files.push((file_path, relative));
    }

    if files.is_empty() {
        return Ok(0);
    }
    let client = http_client();
    for (file_path, relative) in &files {
        let meta = tokio::fs::metadata(file_path)
            .await
            .map_err(|e| format!("Could not inspect {}: {e}", file_path.display()))?;
        if !meta.is_file() {
            return Err(format!("Not a regular file: {}", file_path.display()));
        }
        let file = tokio::fs::File::open(file_path)
            .await
            .map_err(|e| format!("Could not open {}: {e}", file_path.display()))?;
        let response = client
            .post(format!("{root}/api/send/items"))
            .timeout(Duration::from_secs(6 * 60 * 60))
            .header(header::CONTENT_LENGTH, meta.len())
            .header(
                "X-PhoneHaul-Relative-Path",
                urlencoding::encode(relative).into_owned(),
            )
            .body(Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await
            .map_err(|e| format!("Could not queue {}: {e}", file_path.display()))?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(format!(
                "Could not queue {} ({status}): {detail}",
                file_path.display()
            ));
        }
    }
    Ok(files.len())
}
fn take_sse_events(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<Value> {
    buffer.extend_from_slice(chunk);
    let mut events = Vec::new();
    while let Some(pos) = buffer.windows(2).position(|window| window == b"\n\n") {
        let event = &buffer[..pos];
        let data = event
            .split(|byte| *byte == b'\n')
            .find_map(|line| line.strip_prefix(b"data: "));
        if let Some(value) = data.and_then(|bytes| serde_json::from_slice(bytes).ok()) {
            events.push(value);
        }
        buffer.drain(..pos + 2);
    }
    events
}

fn start_events(app: tauri::AppHandle, shared: Shared) {
    tauri::async_runtime::spawn(async move {
        let client = http_client();
        loop {
            let (root, live) = {
                let mut s = shared.lock();
                (s.root.clone(), running(&mut s))
            };
            if live {
                if let Ok(response) = client.get(format!("{root}/api/events")).send().await {
                    let mut stream = response.bytes_stream();
                    use futures_util::StreamExt;
                    let mut buffer = Vec::new();
                    while let Some(Ok(bytes)) = stream.next().await {
                        for data in take_sse_events(&mut buffer, &bytes) {
                            let (host, port) = {
                                let s = shared.lock();
                                (s.host.clone(), s.port)
                            };
                            let _=app.emit("phonehaul://status",json!({"server":{"running":true,"host":host,"port":port},"ui":data}));
                        }
                    }
                }
            }
            let (host, port) = {
                let s = shared.lock();
                (s.host.clone(), s.port)
            };
            let _ = app.emit(
                "phonehaul://status",
                json!({"server":{"running":live,"host":host,"port":port}}),
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Startup size is the content-fit default from tauri.conf.json; only the
                // window position is remembered across runs.
                .with_filename("window-state-compact.json")
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .setup(|app| {
            let mut service = launch(app.handle()).unwrap_or_else(|e| Service {
                child: None,
                stdin: None,
                root: String::new(),
                host: String::new(),
                port: 0,
                error: Some(e),
            });
            let stdin = service.stdin.take();
            let shared: Shared = Arc::new(Mutex::new(service));
            start_events(app.handle().clone(), shared.clone());
            app.manage(shared.clone());
            if let Some(stdin) = stdin {
                heartbeat_loop(shared, stdin, HEARTBEAT_INTERVAL);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            refresh_qr,
            set_destination,
            send_files,
            queue_dropped_paths
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(shared) = app.try_state::<Shared>() {
                    stop(&mut shared.lock());
                }
            }
        });
}
