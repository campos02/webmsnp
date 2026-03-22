// backend for webmsnp
// abandon all hope ye who enter here

mod client_message;
mod message_handlers;
mod server_message;

use crate::client_message::ClientMessage;
use crate::message_handlers::handle_client_message;
use crate::server_message::ServerMessage;
use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
};
use futures::{SinkExt, StreamExt};
use msnp11_sdk::{client::Client, switchboard_server::switchboard::Switchboard};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, mpsc};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{error, info};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

type Sessions = Arc<RwLock<HashMap<String, Arc<Mutex<Client>>>>>;
type Switchboards = Arc<RwLock<HashMap<String, HashMap<String, Arc<Switchboard>>>>>;
type PendingSwitchboards = Arc<RwLock<HashMap<String, Vec<Arc<Switchboard>>>>>;
type UserEmails = Arc<RwLock<HashMap<String, String>>>;

#[derive(Clone)]
pub struct AppState {
    sessions: Sessions,
    switchboards: Switchboards,
    event_tx: mpsc::UnboundedSender<ServerMessage>,
    pending_switchboards: PendingSwitchboards,
    user_emails: UserEmails,
}

#[tokio::main]
async fn main() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("debug")
            .add_directive("hyper::proto::h1::conn=warn".parse().unwrap())
            .add_directive("hyper::proto::h1::io=warn".parse().unwrap())
            .add_directive("tokio::io=error".parse().unwrap())
            .add_directive("msnp11_sdk=warn".parse().unwrap())
            .add_directive("tokio::net=error".parse().unwrap())
            .add_directive("tokio::task=warn".parse().unwrap())
            .add_directive("tungstenite=warn".parse().unwrap())
            .add_directive("tokio_tungstenite=warn".parse().unwrap())
    });

    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .compact(),
        )
        .init();

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new("static"))
        .layer(TraceLayer::new_for_http());

    // MSNP -> 6767 (T9)
    let listener = tokio::net::TcpListener::bind("0.0.0.0:27677")
        .await
        .unwrap();

    info!("Web server listening on 0.0.0.0, port 27677");
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket))
}

async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();
    let session_id = Uuid::new_v4().to_string();

    info!(
        "[WEBSOCKET] New WebSocket connection established - Session ID: {}",
        session_id
    );

    // Create event channel for this session
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        switchboards: Arc::new(RwLock::new(HashMap::new())),
        event_tx,
        pending_switchboards: Arc::new(RwLock::new(HashMap::new())),
        user_emails: Arc::new(RwLock::new(HashMap::new())),
    };

    // Spawn task to forward events to websocket
    let session_id_forward = session_id.clone();
    let state_forward = state.clone();

    let forward_task = tokio::spawn(async move {
        while let Some(msg) = event_rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if let Err(_e) = sender.send(Message::Text(json.into())).await {
                    // Client probably disconnected, stop forwarding
                    // Suppress error logging for normal disconnections
                    break;
                }
            }
        }
        // Clean up when forwarding task ends
        // Disconnect all switchboards first
        if let Some(switchboards) = state_forward
            .switchboards
            .write()
            .await
            .remove(&session_id_forward)
        {
            for (email, switchboard) in switchboards {
                info!(
                    "Disconnecting switchboard with {} on forward task end",
                    email
                );
                let _ = switchboard.disconnect().await;
            }
        }

        // Clean up pending switchboards
        state_forward
            .pending_switchboards
            .write()
            .await
            .remove(&session_id_forward);

        // Clean up user email
        state_forward
            .user_emails
            .write()
            .await
            .remove(&session_id_forward);

        // Disconnect client
        if let Some(client) = state_forward
            .sessions
            .write()
            .await
            .remove(&session_id_forward)
        {
            info!("Disconnecting client on forward task end");
            let _ = client.lock().await.disconnect().await;
        }
    });

    while let Some(result) = receiver.next().await {
        match result {
            Ok(Message::Text(text)) => {
                let response = match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_msg) => {
                        info!(
                            "[WEBSOCKET] Parsed client message successfully for session: {}",
                            session_id
                        );
                        handle_client_message(client_msg, &session_id, &state).await
                    }
                    Err(e) => {
                        error!(
                            "[WEBSOCKET] Failed to parse message for session: {} - Error: {} - Raw message: {}",
                            session_id, e, text
                        );
                        Some(ServerMessage::Error {
                            message: format!("Invalid message format: {}", e),
                        })
                    }
                };

                if let Some(response) = response {
                    let _ = state.event_tx.send(response);
                }
            }
            Ok(Message::Close(_)) => {
                // Client closed connection gracefully
                break;
            }
            Ok(_) => {
                // Ignore ping/pong and other message types
            }
            Err(_) => {
                // Connection error - client probably disconnected abruptly
                // Suppress normal disconnection errors (Winsock 10053/10052)
                // These are: WSAECONNABORTED (10053) and WSAENETRESET (10052)
                // Only log if it's an unexpected error
                break;
            }
        }
    }

    // Cleanup on disconnect - ensure both tasks clean up
    // Disconnect all switchboards first
    if let Some(switchboards) = state.switchboards.write().await.remove(&session_id) {
        for (email, switchboard) in switchboards {
            info!(
                "Disconnecting switchboard with {} on WebSocket close",
                email
            );
            let _ = switchboard.disconnect().await;
        }
    }

    // Clean up pending switchboards
    state.pending_switchboards.write().await.remove(&session_id);

    // Clean up user email
    state.user_emails.write().await.remove(&session_id);

    // Disconnect client (this closes the notification server connection)
    if let Some(client) = state.sessions.write().await.remove(&session_id) {
        info!("Disconnecting client on WebSocket close");
        let _ = client.lock().await.disconnect().await;
    }

    // Wait for forward task to finish
    let _ = forward_task.await;

    info!("WebSocket connection closed: {}", session_id);
}
