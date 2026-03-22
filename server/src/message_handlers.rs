use crate::AppState;
use crate::client_message::ClientMessage;
use crate::server_message::ServerMessage;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use msnp11_sdk::{Client, Event, MsnpList, MsnpStatus, PersonalMessage, PlainText};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};

pub async fn handle_client_message(
    msg: ClientMessage,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    match msg {
        ClientMessage::Login {
            email,
            password,
            server,
            port,
            nexus_url,
            config_server: _,
        } => {
            info!(
                "[MESSAGE_HANDLER] Login message received for session: {} - Email: {}",
                session_id, email
            );
            handle_login(email, password, server, port, nexus_url, session_id, state).await
        }
        ClientMessage::SetPresence { status } => {
            handle_set_presence(status, session_id, state).await
        }
        ClientMessage::SetPersonalMessage { message } => {
            handle_set_personal_message(message, session_id, state).await
        }
        ClientMessage::AddContact { email } => handle_add_contact(email, session_id, state).await,
        ClientMessage::RemoveContact { email } => {
            handle_remove_contact(email, session_id, state).await
        }
        ClientMessage::BlockContact { email } => {
            handle_block_contact(email, session_id, state).await
        }
        ClientMessage::UnblockContact { email } => {
            handle_unblock_contact(email, session_id, state).await
        }
        ClientMessage::StartConversation { email } => {
            handle_start_conversation(email, session_id, state).await
        }
        ClientMessage::SendMessage { email, message } => {
            handle_send_message(email, message, session_id, state).await
        }
        ClientMessage::SendNudge { email } => handle_send_nudge(email, session_id, state).await,
        ClientMessage::SendTyping { email } => handle_send_typing(email, session_id, state).await,
        ClientMessage::CloseConversation { email } => {
            handle_close_conversation(email, session_id, state).await
        }
        ClientMessage::Logout => handle_logout(session_id, state).await,
    }
}

async fn handle_login(
    email: String,
    password: String,
    server: String,
    port: u16,
    nexus_url: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    info!("[LOGIN] Login attempt started for session: {}", session_id);
    info!("[LOGIN] Email: {}", email);
    info!("[LOGIN] Server: {}:{}", server, port);
    info!("[LOGIN] Nexus URL: {}", nexus_url);
    info!("[LOGIN] Password length: {} characters", password.len());

    match Client::new(&server, port).await {
        Ok(client) => {
            info!(
                "[LOGIN] Client connection established successfully for email: {}",
                email
            );
            info!("[LOGIN] Attempting login with SDK for email: {}", email);

            let result = client
                .login(email.clone(), &password, &nexus_url, "webmsnp", "7.0")
                .await;

            info!(
                "[LOGIN] Login SDK call completed for email: {}, result type: {:?}",
                email,
                std::mem::discriminant(&result)
            );

            match result {
                Ok(Event::RedirectedTo { server, port }) => {
                    info!("[LOGIN] User {} redirected to {}:{}", email, server, port);
                    return Some(ServerMessage::Redirected { server, port });
                }
                Ok(Event::Authenticated) => {
                    info!("[LOGIN] User {} successfully authenticated!", email);
                    let client = Arc::new(Mutex::new(client));

                    info!("[LOGIN] Setting up event handler for email: {}", email);
                    // Set up event handler
                    let state_clone = state.clone();
                    let session_id_clone = session_id.to_string();

                    let client_guard = client.lock().await;
                    client_guard.add_event_handler_closure(move |event| {
                        let state_clone = state_clone.clone();
                        let session_id_clone = session_id_clone.clone();

                        async move {
                            // Handle SessionAnswered specially - store it pending until we know which contact it's for
                            if let Event::SessionAnswered(switchboard) = &event {
                                info!("[SWITCHBOARD] SessionAnswered received");

                                // Add event handler to the SessionAnswered switchboard
                                let event_tx_inner = state_clone.event_tx.clone();
                                switchboard.add_event_handler_closure(move |sb_event| {
                                    let event_tx_inner = event_tx_inner.clone();
                                    async move {
                                        let msg = event_to_server_message(sb_event);
                                        if let Some(msg) = msg {
                                            let _ = event_tx_inner.send(msg);
                                        }
                                    }
                                });

                                // Store as pending - we'll match it with ParticipantInSwitchboard event
                                state_clone
                                    .pending_switchboards
                                    .write()
                                    .await
                                    .entry(session_id_clone.clone())
                                    .or_insert_with(Vec::new)
                                    .push(switchboard.clone());

                                info!("[SWITCHBOARD] SessionAnswered switchboard stored as pending");
                            }

                            // Handle ParticipantInSwitchboard - match with pending switchboard
                            let event_tx = state_clone.event_tx;
                            if let Event::ParticipantInSwitchboard { email: participant_email } = &event {
                                info!("[SWITCHBOARD] ParticipantInSwitchboard for {}", participant_email);

                                // Get current user's email to filter out self-participant events
                                let current_user_email = state_clone
                                    .user_emails
                                    .read()
                                    .await
                                    .get(&session_id_clone)
                                    .cloned();

                                // Skip if this is the current user (we don't create switchboards to ourselves)
                                if let Some(ref user_email) = current_user_email {
                                    if participant_email == user_email {
                                        info!("[SWITCHBOARD] Skipping self-participant event for {}", participant_email);
                                        // Don't process further, but still send the event to UI
                                        let msg = event_to_server_message(event);
                                        if let Some(msg) = msg {
                                            let _ = event_tx.send(msg);
                                        }
                                        return;
                                    }
                                }

                                // Only match pending switchboards if we don't already have one for this contact
                                let already_exists = state_clone
                                    .switchboards
                                    .read()
                                    .await
                                    .get(&session_id_clone)
                                    .map(|sb_map| sb_map.contains_key(participant_email))
                                    .unwrap_or(false);

                                if !already_exists {
                                    info!("[SWITCHBOARD] Checking for pending switchboard for {}", participant_email);
                                    // Check if we have a pending switchboard for this session
                                    let mut pending = state_clone.pending_switchboards.write().await;
                                    if let Some(pending_list) = pending.get_mut(&session_id_clone) {
                                        if let Some(switchboard) = pending_list.pop() {
                                            info!("[SWITCHBOARD] Matched pending switchboard with participant {}", participant_email);

                                            // Store it in the switchboards map
                                            state_clone
                                                .switchboards
                                                .write()
                                                .await
                                                .get_mut(&session_id_clone)
                                                .map(|sb_map| {
                                                    sb_map.insert(participant_email.clone(), switchboard);
                                                });

                                            info!("[SWITCHBOARD] Stored switchboard for {}", participant_email);
                                        } else {
                                            info!("[SWITCHBOARD] No pending switchboard available for {}", participant_email);
                                        }
                                    }
                                } else {
                                    info!("[SWITCHBOARD] Switchboard already exists for {}, skipping", participant_email);
                                }
                            }

                            let msg = event_to_server_message(event);
                            if let Some(msg) = msg {
                                // Ignore send errors - channel may be closed if client disconnected
                                let _ = event_tx.send(msg);
                            }
                        }
                    });

                    drop(client_guard);

                    info!("[LOGIN] Storing session for email: {}", email);
                    state
                        .sessions
                        .write()
                        .await
                        .insert(session_id.to_string(), client.clone());

                    info!(
                        "[LOGIN] Storing user email: {} for session: {}",
                        email, session_id
                    );
                    // Store user email for this session
                    state
                        .user_emails
                        .write()
                        .await
                        .insert(session_id.to_string(), email.clone());

                    info!("[LOGIN] Initializing switchboards map for email: {}", email);
                    // Initialize switchboards map for this session
                    state
                        .switchboards
                        .write()
                        .await
                        .insert(session_id.to_string(), HashMap::new());

                    info!(
                        "[LOGIN] Initializing pending switchboards for email: {}",
                        email
                    );
                    // Initialize pending switchboards for this session
                    state
                        .pending_switchboards
                        .write()
                        .await
                        .insert(session_id.to_string(), Vec::new());

                    info!(
                        "[LOGIN] Setting initial presence to Online for email: {}",
                        email
                    );
                    // initial presence is online
                    if let Err(e) = client.lock().await.set_presence(MsnpStatus::Online).await {
                        error!(
                            "[LOGIN] Failed to set initial presence for {}: {:?}",
                            email, e
                        );
                    } else {
                        info!(
                            "[LOGIN] Initial presence set successfully for email: {}",
                            email
                        );
                    }

                    info!("[LOGIN] Login complete and successful for email: {}", email);
                    return Some(ServerMessage::Authenticated);
                }
                Err(e) => {
                    error!("[LOGIN] Login failed for email: {} - Error: {:?}", email, e);
                    return Some(ServerMessage::Error {
                        message: format!("Login failed: {:?}", e),
                    });
                }
                _ => {
                    error!(
                        "[LOGIN] Unexpected event received for email: {} during login",
                        email
                    );
                }
            }
        }
        Err(e) => {
            error!(
                "[LOGIN] Failed to create client connection for email: {} - Error: {:?}",
                email, e
            );
            return Some(ServerMessage::Error {
                message: format!("Connection failed: {:?}", e),
            });
        }
    }
    error!(
        "[LOGIN] Login resulted in unexpected state for email: {}",
        email
    );
    None
}

fn event_to_server_message(event: Event) -> Option<ServerMessage> {
    match event {
        Event::Group { name, guid } => Some(ServerMessage::Group { name, guid }),
        Event::Contact {
            email,
            display_name,
            lists,
        } => {
            let list_strings: Vec<String> = lists.iter().map(|l| format!("{:?}", l)).collect();
            Some(ServerMessage::Contact {
                email,
                display_name,
                lists: list_strings,
                groups: None,
            })
        }
        Event::ContactInForwardList {
            email,
            display_name,
            guid: _,
            lists,
            groups,
        } => {
            let list_strings: Vec<String> = lists.iter().map(|l| format!("{:?}", l)).collect();
            Some(ServerMessage::Contact {
                email,
                display_name,
                lists: list_strings,
                groups: Some(groups),
            })
        }
        Event::InitialPresenceUpdate {
            email,
            display_name,
            presence,
        }
        | Event::PresenceUpdate {
            email,
            display_name,
            presence,
        } => Some(ServerMessage::PresenceUpdate {
            email,
            display_name,
            status: format!("{:?}", presence.status),
            client_id: Some(presence.client_id),
        }),
        Event::PersonalMessageUpdate {
            email,
            personal_message,
        } => Some(ServerMessage::PersonalMessageUpdate {
            email,
            message: personal_message.psm,
            current_media: personal_message.current_media,
        }),
        Event::ContactOffline { email } => Some(ServerMessage::ContactOffline { email }),
        Event::AddedBy {
            email,
            display_name,
        } => Some(ServerMessage::AddedBy {
            email,
            display_name,
        }),
        Event::RemovedBy(email) => Some(ServerMessage::RemovedBy { email }),
        Event::SessionAnswered(_switchboard) => {
            // This happens when a contact accepts our switchboard invitation
            // We need to store this but don't have access to state here
            // for now just log
            info!("SessionAnswered event received - switchboard ready");
            None
        }
        Event::TextMessage { email, message } => {
            // Messages are not logged by default for privacy reasons - uncomment for debugging ONLY
            // info!("[RECV] TextMessage event from {}: '{}'", email, message.text);
            Some(ServerMessage::TextMessage {
                email,
                message: message.text.clone(),
                color: Some(message.color.clone()),
            })
        }
        Event::Nudge { email } => Some(ServerMessage::Nudge { email }),
        Event::TypingNotification { email } => Some(ServerMessage::Typing { email }),
        Event::ParticipantInSwitchboard { email } => {
            info!("[PARTICIPANT] {} joined switchboard", email);
            Some(ServerMessage::ParticipantJoined { email })
        }
        Event::ParticipantLeftSwitchboard { email } => {
            Some(ServerMessage::ParticipantLeft { email })
        }
        Event::DisplayPicture { email, data } => Some(ServerMessage::DisplayPicture {
            email,
            data: BASE64.encode(&data),
        }),
        Event::Disconnected | Event::LoggedInAnotherDevice => Some(ServerMessage::Disconnected),
        _ => None,
    }
}

async fn handle_set_presence(
    status: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    info!("Setting presence to {} for session {}", status, session_id);
    if let Some(client) = state.sessions.read().await.get(session_id) {
        let msnp_status = match status.as_str() {
            "Online" => MsnpStatus::Online,
            "Busy" => MsnpStatus::Busy,
            "Idle" => MsnpStatus::Idle,
            "BeRightBack" => MsnpStatus::BeRightBack,
            "Away" => MsnpStatus::Away,
            "OnThePhone" => MsnpStatus::OnThePhone,
            "OutToLunch" => MsnpStatus::OutToLunch,
            "Invisible" => MsnpStatus::AppearOffline,
            _ => {
                return Some(ServerMessage::Error {
                    message: "Invalid status".to_string(),
                });
            }
        };

        match client.lock().await.set_presence(msnp_status.clone()).await {
            Ok(_) => {
                info!("Successfully set presence to {:?}", msnp_status);
                None
            }
            Err(e) => {
                error!("Failed to set presence: {:?}", e);
                Some(ServerMessage::Error {
                    message: format!("Failed to set presence: {:?}", e),
                })
            }
        }
    } else {
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_set_personal_message(
    message: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    info!(
        "Setting personal message to '{}' for session {}",
        message, session_id
    );
    if let Some(client) = state.sessions.read().await.get(session_id) {
        let pm = PersonalMessage {
            psm: message,
            current_media: String::new(),
        };
        match client.lock().await.set_personal_message(&pm).await {
            Ok(_) => {
                info!("Successfully set personal message");
                None
            }
            Err(e) => {
                error!("Failed to set personal message: {:?}", e);
                Some(ServerMessage::Error {
                    message: format!("Failed to set personal message: {:?}", e),
                })
            }
        }
    } else {
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_add_contact(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    info!("Adding contact {} for session {}", email, session_id);
    if let Some(client) = state.sessions.read().await.get(session_id) {
        match client
            .lock()
            .await
            .add_contact(&email, &email, MsnpList::ForwardList)
            .await
        {
            Ok(_) => {
                info!("Successfully added contact {}", email);
                None
            }
            Err(e) => {
                error!("Failed to add contact {}: {:?}", email, e);
                Some(ServerMessage::Error {
                    message: format!("Failed to add contact: {:?}", e),
                })
            }
        }
    } else {
        error!("No session found for add contact request");
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_remove_contact(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(client) = state.sessions.read().await.get(session_id) {
        match client
            .lock()
            .await
            .remove_contact_from_forward_list(&email)
            .await
        {
            Ok(_) => None,
            Err(e) => Some(ServerMessage::Error {
                message: format!("Failed to remove contact: {:?}", e),
            }),
        }
    } else {
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_block_contact(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(client) = state.sessions.read().await.get(session_id) {
        match client.lock().await.block_contact(&email).await {
            Ok(_) => None,
            Err(e) => Some(ServerMessage::Error {
                message: format!("Failed to block contact: {:?}", e),
            }),
        }
    } else {
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_unblock_contact(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(client) = state.sessions.read().await.get(session_id) {
        match client.lock().await.unblock_contact(&email).await {
            Ok(_) => None,
            Err(e) => Some(ServerMessage::Error {
                message: format!("Failed to unblock contact: {:?}", e),
            }),
        }
    } else {
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_start_conversation(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    info!(
        "Starting conversation with {} for session {}",
        email, session_id
    );
    // does switchboard already exist? if so no need to make another one
    if let Some(switchboards) = state.switchboards.read().await.get(session_id) {
        if switchboards.contains_key(&email) {
            info!("Switchboard already exists for {}, reusing it", email);
            return Some(ServerMessage::ConversationReady { email });
        }
    }

    if let Some(client) = state.sessions.read().await.get(session_id) {
        match client.lock().await.create_session(&email).await {
            Ok(switchboard) => {
                info!("Successfully created switchboard session for {}", email);
                let switchboard = Arc::new(switchboard);

                // Set up event handler for switchboard
                let event_tx = state.event_tx.clone();
                switchboard.add_event_handler_closure(move |event| {
                    let event_tx = event_tx.clone();
                    async move {
                        let msg = event_to_server_message(event);
                        if let Some(msg) = msg {
                            let _ = event_tx.send(msg);
                        }
                    }
                });

                // Store switchboard
                state
                    .switchboards
                    .write()
                    .await
                    .get_mut(session_id)
                    .unwrap()
                    .insert(email.clone(), switchboard.clone());

                // create_session already handles the invitation, no need to call invite again
                // revelation courtesy of campos02 himself
                info!(
                    "Switchboard created and invitation sent via create_session for {}",
                    email
                );
                Some(ServerMessage::ConversationReady { email })
            }
            Err(e) => {
                error!("Failed to create session for {}: {:?}", email, e);
                Some(ServerMessage::Error {
                    message: format!("Failed to create session: {:?}", e),
                })
            }
        }
    } else {
        error!("No session found for {}", session_id);
        Some(ServerMessage::Error {
            message: "Not logged in".to_string(),
        })
    }
}

async fn handle_send_message(
    email: String,
    message: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    // Messages are not logged by default for privacy reasons - uncomment for debugging ONLY
    // info!("[SEND] Session {} sending to {}: '{}'", session_id, email, message);

    // Try to get existing switchboard
    let switchboard = state
        .switchboards
        .read()
        .await
        .get(session_id)
        .and_then(|m| m.get(&email))
        .cloned();

    let switchboard = if let Some(sb) = switchboard {
        Some(sb)
    } else {
        // No switchboard found - check if there's a pending one we can claim
        info!(
            "[SEND] No switchboard found for {}, checking pending switchboards",
            email
        );
        let mut pending = state.pending_switchboards.write().await;
        if let Some(pending_list) = pending.get_mut(session_id) {
            if let Some(pending_sb) = pending_list.pop() {
                info!(
                    "[SEND] Found pending switchboard, claiming it for {}",
                    email
                );

                // Store it permanently
                state
                    .switchboards
                    .write()
                    .await
                    .get_mut(session_id)
                    .map(|sb_map| {
                        sb_map.insert(email.clone(), pending_sb.clone());
                    });

                Some(pending_sb)
            } else {
                info!("[SEND] No pending switchboards available");
                None
            }
        } else {
            None
        }
    };

    if let Some(switchboard) = switchboard {
        let plain_text = PlainText {
            bold: false,
            italic: false,
            underline: false,
            strikethrough: false,
            color: "000000".to_string(),
            text: message.clone(),
        };

        match switchboard.send_text_message(&plain_text).await {
            Ok(_) => {
                info!("[SEND] Message delivered to switchboard for {}", email);
                None
            }
            Err(e) => {
                error!("[SEND] Failed to send message to {}: {:?}", email, e);
                Some(ServerMessage::Error {
                    message: format!("Failed to send message: {:?}", e),
                })
            }
        }
    } else {
        error!(
            "[SEND] No switchboard or pending switchboard found for {}",
            email
        );
        Some(ServerMessage::Error {
            message: "No conversation with this contact".to_string(),
        })
    }
}

async fn handle_send_nudge(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(switchboard) = state
        .switchboards
        .read()
        .await
        .get(session_id)
        .and_then(|m| m.get(&email))
    {
        match switchboard.send_nudge().await {
            Ok(_) => None,
            Err(e) => Some(ServerMessage::Error {
                message: format!("Failed to send nudge: {:?}", e),
            }),
        }
    } else {
        Some(ServerMessage::Error {
            message: "No conversation with this contact".to_string(),
        })
    }
}

async fn handle_send_typing(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(switchboard) = state
        .switchboards
        .read()
        .await
        .get(session_id)
        .and_then(|m| m.get(&email))
    {
        match switchboard.send_typing_user(&email).await {
            Ok(_) => None,
            Err(e) => Some(ServerMessage::Error {
                message: format!("Failed to send typing notification: {:?}", e),
            }),
        }
    } else {
        None
    }
}

async fn handle_close_conversation(
    email: String,
    session_id: &str,
    state: &AppState,
) -> Option<ServerMessage> {
    if let Some(switchboards) = state.switchboards.write().await.get_mut(session_id) {
        switchboards.remove(&email);
    }

    None
}

async fn handle_logout(session_id: &str, state: &AppState) -> Option<ServerMessage> {
    info!("Logging out session: {}", session_id);

    // Disconnect all switchboards first
    if let Some(switchboards) = state.switchboards.write().await.remove(session_id) {
        for (email, switchboard) in switchboards {
            info!("Disconnecting switchboard with {}", email);
            let _ = switchboard.disconnect().await;
        }
    }

    // Clean up pending switchboards
    state.pending_switchboards.write().await.remove(session_id);

    // Clean up user email
    state.user_emails.write().await.remove(session_id);

    // Disconnect client (this closes the notification server connection)
    if let Some(client) = state.sessions.write().await.remove(session_id) {
        info!("Disconnecting client for session {}", session_id);
        let _ = client.lock().await.disconnect().await;
    }

    // Event channel gets dropped with state later
    info!("Successfully logged out session: {}", session_id);
    Some(ServerMessage::Disconnected)
}
