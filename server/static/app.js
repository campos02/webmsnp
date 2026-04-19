(function() {
    'use strict';
    
    var ws = null;
    var currentContact = null;
    var contacts = {};
    var conversations = {};
    var conversationStates = {};
    var queuedMessages = {};
    var typingTimers = {};
    var isRedirecting = false;
    var loginAttemptActive = false;
    var pendingLoginMessage = null;
    var websocketUrls = [];
    var websocketAttemptIndex = 0;
    var websocketOpened = false;
    var websocketRetryTimer = null;
    var forceHttpEnabled = false;
    var userAgent = window.navigator && window.navigator.userAgent ? window.navigator.userAgent : '';

    var configuredServices = {
        crosstalk: {
            server: 'ms.msgrsvcs.ctsrv.gay',
            port: 1863,
            nexus: 'pp.login.ugnet.gay',
            config: 'config.login.ugnet.gay'
        },
        crosstalk_nodispatch: {
            server: 'ms.msgrsvcs.ctsrv.gay',
            port: 1864,
            nexus: 'pp.login.ugnet.gay',
            config: 'config.login.ugnet.gay'
        },
        legacy: {
            server: 'messenger.hotmail.com',
            port: 1863,
            nexus: 'nexus.passport.com',
            config: 'config.messenger.msn.com'
        }
    };

    function isUnsupportedIOSDevice() {
        return /(iPhone|iPad|iPod)/.test(userAgent) && /OS [1-5]_/.test(userAgent) && /Safari/.test(userAgent);
    }
    
    // theres definitely a better way to do this lmao
    var loginScreen = document.getElementById('loginScreen');
    var mainScreen = document.getElementById('mainScreen');
    var chatScreen = document.getElementById('chatScreen');
    var loginForm = document.getElementById('loginForm');
    var requiredLoginInputs = loginForm ? loginForm.querySelectorAll('input[required]') : [];
    var loginBtn = document.getElementById('loginBtn');
    var serviceSelect = document.getElementById('service');
    var forceHttpToggle = document.getElementById('forceHttp');
    var serverInput = document.getElementById('server');
    var portInput = document.getElementById('port');
    var nexusInput = document.getElementById('nexus');
    var configInput = document.getElementById('config');
    var loginError = document.getElementById('loginError');
    var loginStatus = document.getElementById('loginStatus');
    var statusSelect = document.getElementById('statusSelect');
    var reloadBtn = document.getElementById('reloadBtn');
    var logoutBtn = document.getElementById('logoutBtn');
    var personalMessageInput = document.getElementById('personalMessageInput');
    var setPsmBtn = document.getElementById('setPsmBtn');
    var addContactInput = document.getElementById('addContactInput');
    var addContactBtn = document.getElementById('addContactBtn');
    var contactList = document.getElementById('contactList');
    var chatTitle = document.getElementById('chatTitle');
    var nudgeBtn = document.getElementById('nudgeBtn');
    var closeChatBtn = document.getElementById('closeChatBtn');
    var messageContainer = document.getElementById('messageContainer');
    var messageInput = document.getElementById('messageInput');
    var customServiceRows = loginForm ? loginForm.querySelectorAll('.custom-service-row') : [];

    function normalizeHostInput(rawValue) {
        var value = (rawValue || '').trim();
        if (!value) return '';

        value = value.replace(/^https?:\/\//i, '');
        value = value.replace(/\/.*$/, '');
        value = value.replace(/\s+/g, '');
        return value;
    }

    function buildServiceUrl(hostInput, pathSuffix, forceHttp) {
        var host = normalizeHostInput(hostInput);
        if (!host) return '';
        var protocol = forceHttp ? 'http://' : 'https://';
        return protocol + host + pathSuffix;
    }

    function getSelectedServiceConfig() {
        var selectedService = serviceSelect ? serviceSelect.value : 'custom';
        var useCustom = selectedService === 'custom';
        var preset = configuredServices[selectedService] || null;

        if (!useCustom && preset) {
            return {
                server: preset.server,
                port: preset.port,
                nexus: preset.nexus,
                config: preset.config,
                useCustom: false
            };
        }

        return {
            server: serverInput ? serverInput.value.trim() : '',
            port: portInput ? parseInt(portInput.value, 10) : NaN,
            nexus: nexusInput ? nexusInput.value.trim() : '',
            config: configInput ? configInput.value.trim() : '',
            useCustom: true
        };
    }

    function updateServiceFieldsVisibility() {
        var useCustom = !serviceSelect || serviceSelect.value === 'custom';
        var i;

        for (i = 0; i < customServiceRows.length; i++) {
            customServiceRows[i].style.display = useCustom ? 'block' : 'none';
        }

        updateLoginButtonState();
    }
    
    // Strip Messenger Plus! format tags from usernames
    function cleanDisplayName(name, maxLength) {
        var cleaned = name.replace(/\[.*?\]/g, '');
        if (maxLength && cleaned.length > maxLength) {
            return cleaned.substring(0, maxLength) + '...';
        }
        return cleaned;
    }
    
    // websocket init
    function connectWebSocket() {
        if (isUnsupportedIOSDevice()) {
            showError('Unsupported device');
            return;
        }

        var protocol = forceHttpEnabled ? 'ws:' : (window.location.protocol === 'https:' ? 'wss:' : 'ws:');
        var host = window.location.hostname;
        var port = window.location.port ? ':' + window.location.port : '';
        var baseUrl = protocol + '//' + host + port;

        if (!websocketUrls.length) {
            websocketUrls = [
                baseUrl + '/ws',
                baseUrl + '/websocket',
                baseUrl + '/'
            ];
        }

        if (websocketRetryTimer) {
            clearTimeout(websocketRetryTimer);
            websocketRetryTimer = null;
        }

        var wsUrl = websocketUrls[websocketAttemptIndex];
        if (!wsUrl) {
            console.error('[CLIENT_WS] No websocket URLs left to try');
            showError('Connection closed. Please refresh and sign in again.');
            return;
        }
        
        console.log('[CLIENT_WS] Connecting to WebSocket:', wsUrl);
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            websocketOpened = true;
            console.log('[CLIENT_WS] WebSocket connection opened successfully');
            if (pendingLoginMessage) {
                console.log('[CLIENT_WS] Sending queued login message');
                ws.send(JSON.stringify(pendingLoginMessage));
                pendingLoginMessage = null;
            }
        };
        
        ws.onmessage = function(event) {
            try {
                console.log('[CLIENT_WS] Raw message received (length:', event.data.length, ')');
                console.log('[CLIENT_WS] Message data:', event.data);
                var message = JSON.parse(event.data);
                handleServerMessage(message);
            } catch (e) {
                console.error('[CLIENT_WS] Failed to parse message:', e);
                console.error('[CLIENT_WS] Raw message data:', event.data);
            }
        };
        
        ws.onerror = function(error) {
            console.error('[CLIENT_WS] WebSocket error occurred:', error);
        };
        
        ws.onclose = function() {
            console.log('[CLIENT_WS] WebSocket connection closed');
            console.log('[CLIENT_WS] isRedirecting flag:', isRedirecting);
            if (websocketOpened) {
                websocketOpened = false;
                return;
            }

            websocketAttemptIndex += 1;
            if (pendingLoginMessage && websocketAttemptIndex < websocketUrls.length) {
                websocketRetryTimer = setTimeout(function() {
                    connectWebSocket();
                }, 250);
                return;
            }

            if (!isRedirecting && loginAttemptActive) {
                showError('Connection closed. Please refresh and sign in again.');
            }
        };
    }
    
    function sendMessage(message) {
        console.log('[CLIENT_SEND] Attempting to send message, type:', message.type);
        if (message.type === 'login') {
            console.log('[CLIENT_SEND] Login message details - Email:', message.email);
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            var jsonStr = JSON.stringify(message);
            console.log('[CLIENT_SEND] WebSocket ready, sending JSON (length:', jsonStr.length, ')');
            ws.send(jsonStr);
            console.log('[CLIENT_SEND] Message sent successfully');
        } else {
            console.error('[CLIENT_SEND] WebSocket not ready, readyState:', ws ? ws.readyState : 'null');
            showError('Not connected to server');
        }
    }
    
    function handleServerMessage(message) {
        if (message.type !== 'typing') { // Don't log typing notifs since otherwise it'll blow up the console
            console.log('[CLIENT_RECEIVE] Received message type:', message.type);
        }
        
        // switch-case of doom and despair
        switch (message.type) {
            case 'redirected':
                console.log('[CLIENT_RECEIVE] Redirect message received');
                handleRedirect(message.server, message.port);
                break;
            case 'authenticated':
                console.log('[CLIENT_RECEIVE] Authenticated message received - login successful!');
                handleAuthenticated();
                break;
            case 'error':
                console.error('[CLIENT_RECEIVE] Error message received:', message.message);
                console.error('[CLIENT_RECEIVE] Full error object:', JSON.stringify(message));
                showError(message.message);
                break;
            case 'contact':
                handleContact(message);
                break;
            case 'group':
                handleGroup(message);
                break;
            case 'presenceUpdate':
                handlePresenceUpdate(message);
                break;
            case 'personalMessageUpdate':
                handlePersonalMessageUpdate(message);
                break;
            case 'contactOffline':
                handleContactOffline(message.email);
                break;
            case 'addedBy':
                handleAddedBy(message);
                break;
            case 'removedBy':
                handleRemovedBy(message.email);
                break;
            case 'conversationReady':
                console.log('[CLIENT] ConversationReady received for:', message.email);
                handleConversationReady(message.email);
                break;
            case 'textMessage':
                handleTextMessage(message);
                break;
            case 'nudge':
                handleNudge(message.email);
                break;
            case 'typing':
                handleTypingNotification(message.email);
                break;
            case 'participantJoined':
                console.log('[CLIENT] ParticipantJoined received for:', message.email);
                handleParticipantJoined(message.email);
                break;
            case 'participantLeft':
                handleParticipantLeft(message.email);
                break;
            case 'displayPicture':
                handleDisplayPicture(message);
                break;
            case 'disconnected':
                handleDisconnected(message);
                break;
        }
    }
    
    function handleLogin(e) {
        if (e) e.preventDefault();

        var email = document.getElementById('email').value.trim();
        var password = document.getElementById('password').value;
        var serviceConfig = getSelectedServiceConfig();
        var server = serviceConfig.server;
        var port = serviceConfig.port;
        var forceHttp = forceHttpToggle ? !!forceHttpToggle.checked : false;
        var nexusUrl = buildServiceUrl(serviceConfig.nexus, '/rdr/pprdr.asp', forceHttp);
        var configServer = buildServiceUrl(serviceConfig.config, '/Config/MsgrConfig.asmx', forceHttp);
        var emailCharCodes = [];
        var emailIdx;
        
        console.log('[CLIENT_LOGIN] Login attempt initiated');
        console.log('[CLIENT_LOGIN] Email entered:', email);
        console.log('[CLIENT_LOGIN] Email length:', email.length);
        for (emailIdx = 0; emailIdx < email.length; emailIdx++) {
            emailCharCodes.push(email.charCodeAt(emailIdx));
        }
        console.log('[CLIENT_LOGIN] Email char codes:', emailCharCodes);
        console.log('[CLIENT_LOGIN] Password length:', password.length);
        console.log('[CLIENT_LOGIN] Server:', server, ':', port);
        console.log('[CLIENT_LOGIN] Nexus URL:', nexusUrl);
        console.log('[CLIENT_LOGIN] Config Server:', configServer || '(none)');
        console.log('[CLIENT_LOGIN] Force HTTP:', forceHttp);
        
        if (!email || !password || !server || !port || !nexusUrl || !configServer) {
            console.error('[CLIENT_LOGIN] Validation failed - missing required fields');
            showError('Please fill in all required fields');
            updateLoginButtonState();
            return;
        }
        
        console.log('[CLIENT_LOGIN] Validation passed, preparing login message');
        forceHttpEnabled = forceHttp;
        loginAttemptActive = true;
        websocketAttemptIndex = 0;
        websocketOpened = false;
        loginBtn.disabled = true;
        loginBtn.innerHTML = 'Signing in...';
        hideError();
        hideStatus();

        pendingLoginMessage = {
            type: 'login',
            email: email,
            password: password,
            server: server,
            port: port,
            nexus_url: nexusUrl,
            config_server: configServer || null

        };

        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(pendingLoginMessage));
            pendingLoginMessage = null;
            console.log('[CLIENT_LOGIN] Login message sent to server');
        } else {
            showStatus('Connecting to server...');
            console.log('[CLIENT_LOGIN] Login queued until WebSocket opens');
        }
    }
    
    function handleRedirect(server, port) {
        showStatus('Redirecting to ' + server + ':' + port + '...');
        isRedirecting = true;
        if (ws) {
            ws.close();
        }
        
        // patience is a virtue
        setTimeout(function() {
            console.log('[CLIENT_REDIRECT] Reconnecting WebSocket...');
            connectWebSocket();
            
            // patience is a virtue 2
            setTimeout(function() {
                isRedirecting = false;
                var email = document.getElementById('email').value.trim();
                var password = document.getElementById('password').value;
                var serviceConfig = getSelectedServiceConfig();
                var nexusUrl = buildServiceUrl(serviceConfig.nexus, '/rdr/pprdr.asp', forceHttpEnabled);
                var configServer = buildServiceUrl(serviceConfig.config, '/Config/MsgrConfig.asmx', forceHttpEnabled);
                
                console.log('[CLIENT_REDIRECT] Re-attempting login after redirect with email:', email);
                websocketAttemptIndex = 0;
                websocketOpened = false;
                pendingLoginMessage = {
                    type: 'login',
                    email: email,
                    password: password,
                    server: server,
                    port: port,
                    nexus_url: nexusUrl,
                    config_server: configServer || null
                };
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(pendingLoginMessage));
                    pendingLoginMessage = null;
                    console.log('[CLIENT_REDIRECT] Redirect login message sent');
                } else {
                    console.log('[CLIENT_REDIRECT] Redirect login queued until WebSocket opens');
                }
            }, 2000);
        }, 2000);
    }
    
    function handleAuthenticated() {
        loginAttemptActive = false;
        loginBtn.disabled = false;
        loginBtn.innerHTML = 'Signed in!';
        hideError();
        showStatus('Signed in successfully!');
        
        setTimeout(function() {
            loginScreen.style.display = 'none';
            mainScreen.style.display = 'block';
            // Adjust contact list height after screen is shown
            setTimeout(adjustContactListHeight, 50);
        }, 500);
    }
    
    function handleContact(contact) {
        contacts[contact.email] = {
            email: contact.email,
            displayName: contact.display_name,
            status: 'Offline',
            personalMessage: '',
            lists: contact.lists,
            groups: contact.groups || []
        };
        updateContactList();
    }
    
    function handleGroup(group) {
        console.log('Group:', group.name, group.guid);
    }
    
    function handlePresenceUpdate(update) {
        if (contacts[update.email]) {
            contacts[update.email].displayName = update.display_name;
            contacts[update.email].status = update.status;
            updateContactList();
        }
    }
    
    function handlePersonalMessageUpdate(update) {
        if (contacts[update.email]) {
            contacts[update.email].personalMessage = update.message;
            updateContactList();
        }
    }
    
    function handleContactOffline(email) {
        if (contacts[email]) {
            contacts[email].status = 'Offline';
            updateContactList();
        }
    }
    
    function handleAddedBy(data) {
        showStatus(data.display_name + ' (' + data.email + ') added you to their contact list');
    }
    
    function handleRemovedBy(email) {
        showStatus(email + ' removed you from their contact list');
    }
    
    function handleConversationReady(email) {
        console.log('[CLIENT] handleConversationReady - email:', email, '| conversations[email]:', !!conversations[email], '| currentContact:', currentContact);
        if (!conversations[email]) {
            conversations[email] = [];
        }
        conversationStates[email] = 'ready';
        flushQueuedMessages(email);
        openChat(email);
        console.log('[CLIENT] handleConversationReady - chat opened for', email);
    }
    
    function handleTextMessage(msg) {
        console.log('[CLIENT] handleTextMessage - from:', msg.email, '| text:', msg.message);
        conversationStates[msg.email] = 'ready';
        if (!conversations[msg.email]) {
            conversations[msg.email] = [];
            console.log('[CLIENT] handleTextMessage - initialized conversation for', msg.email);
        }
        
        var message = {
            sender: msg.email,
            text: msg.message,
            time: new Date(),
            color: msg.color
        };
        
        conversations[msg.email].push(message);
        console.log('[CLIENT] handleTextMessage - message stored | currentContact:', currentContact, '| sender:', msg.email);
        
        if (currentContact === msg.email) {
            console.log('Displaying message in UI');
            displayMessage(message, false);
            scrollToBottom();
        }
    }
    
    function handleNudge(email) {
        if (currentContact === email) {
            // Visual feedback
            addSystemMessage('💥 ' + (contacts[email] ? contacts[email].displayName : email) + ' sent you a nudge!');
            
            // Shake animation (with webkit prefix for iOS 6)
            var chatScreen = document.getElementById('chatScreen');
            chatScreen.style.webkitAnimation = 'shake 0.5s';
            chatScreen.style.animation = 'shake 0.5s';
            setTimeout(function() {
                chatScreen.style.webkitAnimation = '';
                chatScreen.style.animation = '';
            }, 500);
            
            // Vibration for mobile
            if (window.navigator && window.navigator.vibrate) {
                window.navigator.vibrate([100, 50, 100, 50, 100]);
            }
        }
    }
    
    // Handle typing notification
    // showTypingIndicator is broken atm, fix later
    function handleTypingNotification(email) {
        if (currentContact === email) {
            showTypingIndicator(email);
        }
    }
    
    function handleParticipantJoined(email) {
        console.log('[CLIENT] handleParticipantJoined - email:', email, '| conversations[email]:', !!conversations[email], '| currentContact:', currentContact);
        conversationStates[email] = 'ready';
        flushQueuedMessages(email);
        
        // Initialize conversation if it doesn't exist
        if (!conversations[email]) {
            conversations[email] = [];
            console.log('[CLIENT] handleParticipantJoined - initialized conversations array for', email);
        }
        
        // If this contact isn't currently open in chat, open it
        // (This handles cases where the contact initiated the switchboard)
        if (currentContact !== email) {
            console.log('[CLIENT] handleParticipantJoined - opening chat for', email);
            openChat(email);
        } else {
            // Already in chat with this contact, just add system message
            console.log('[CLIENT] handleParticipantJoined - already in chat with', email, '- adding system message');
            addSystemMessage(email + ' joined the conversation');
        }
    }
    
    function handleParticipantLeft(email) {
        if (currentContact === email) {
            addSystemMessage(email + ' left the conversation');
        }
    }
    
    function handleDisconnected(message) {
        var reason = (message && message.message) ? message.message : 'Conversation disconnected';
        console.warn('[CLIENT] Disconnected event received:', message);

        // Treat this as a non-fatal runtime event to avoid forced logout/reload loops.
        if (chatScreen.style.display !== 'none' && currentContact) {
            delete conversationStates[currentContact];
            delete queuedMessages[currentContact];
            addSystemMessage(reason);
            chatScreen.style.display = 'none';
            mainScreen.style.display = 'block';
            adjustContactListHeight();
            currentContact = null;
            return;
        }

        showStatus(reason);
    }
    
    function updateContactList() {
        contactList.innerHTML = '';
        
        var sortedContacts = [];
        for (var email in contacts) {
            if (contacts.hasOwnProperty(email)) {
                sortedContacts.push(contacts[email]);
            }
        }
        
        sortedContacts.sort(function(a, b) {
            // Online contacts first
            var aOnline = a.status !== 'Offline';
            var bOnline = b.status !== 'Offline';
            if (aOnline !== bOnline) return bOnline - aOnline;
            
            // Then by display name
            return a.displayName.localeCompare(b.displayName);
        });
        
        for (var i = 0; i < sortedContacts.length; i++) {
            var contact = sortedContacts[i];
            var item = createContactItem(contact);
            contactList.appendChild(item);
        }
    }
    
    function createContactItem(contact) {
        var item = document.createElement('div');
        item.className = 'contact-item';
        
        var statusIndicator = document.createElement('div');
        statusIndicator.className = 'contact-status ' + getStatusClass(contact.status);
        
        var info = document.createElement('div');
        info.className = 'contact-info';
        
        var name = document.createElement('div');
        name.className = 'contact-name';
        name.textContent = cleanDisplayName(contact.displayName);
        
        var email = document.createElement('div');
        email.className = 'contact-email';
        email.textContent = contact.email;
        
        info.appendChild(name);
        info.appendChild(email);
        
        if (contact.personalMessage) {
            var psm = document.createElement('div');
            psm.className = 'contact-psm';
            psm.textContent = contact.personalMessage;
            info.appendChild(psm);
        }
        
        item.appendChild(statusIndicator);
        item.appendChild(info);
        
        item.onclick = function() {
            startConversation(contact.email);
        };
        
        return item;
    }
    
    function getStatusClass(status) {
        if (status === 'Online' || status === 'Idle') return 'online';
        if (status === 'Busy' || status === 'OnThePhone') return 'busy';
        if (status === 'Away' || status === 'BeRightBack' || status === 'OutToLunch') return 'away';
        return 'offline';
    }
    
    function startConversation(email) {
        console.log('startConversation called for:', email);
        if (conversationStates[email] === 'ready') {
            console.log('Conversation already ready, opening chat for:', email);
            openChat(email);
            return;
        }

        if (conversationStates[email] === 'starting') {
            console.log('Conversation already starting for:', email);
            return;
        }

        if (!conversations[email]) {
            conversations[email] = [];
        }

        conversationStates[email] = 'starting';
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('Sending startConversation request for:', email);
            sendMessage({
                type: 'startConversation',
                email: email
            });
        } else {
            console.warn('WebSocket not ready, cannot start conversation yet for:', email);
            showStatus('Connecting... please try again.');
        }
    }

    function queueMessage(email, text) {
        if (!queuedMessages[email]) {
            queuedMessages[email] = [];
        }
        queuedMessages[email].push(text);
    }

    function sendChatMessage(email, text) {
        if (!text || !email) return;

        console.log('[CLIENT] Sending message to', email, '- text:', text.substring(0, 50));
        sendMessage({
            type: 'sendMessage',
            email: email,
            message: text
        });

        var msg = {
            sender: getUserEmail(),
            text: text,
            time: new Date()
        };

        if (!conversations[email]) {
            conversations[email] = [];
        }
        conversations[email].push(msg);

        if (currentContact === email) {
            displayMessage(msg, true);
            scrollToBottom();
        }
    }

    function flushQueuedMessages(email) {
        if (!queuedMessages[email] || !queuedMessages[email].length) {
            return;
        }

        while (queuedMessages[email].length) {
            sendChatMessage(email, queuedMessages[email].shift());
        }
        delete queuedMessages[email];
    }
    
    function openChat(email) {
        currentContact = email;
        var contact = contacts[email];
        
        if (contact) {
            chatTitle.textContent = cleanDisplayName(contact.displayName, 28);
        } else {
            // Truncate email if too long
            chatTitle.textContent = email.length > 28 ? email.substring(0, 28) + '...' : email;
        }
        
        messageContainer.innerHTML = '';
        messageInput.value = ''; // Clear input when switching contacts
        
        if (conversations[email] && conversations[email].length) {
            for (var i = 0; i < conversations[email].length; i++) {
                var msg = conversations[email][i];
                displayMessage(msg, msg.sender === getUserEmail());
            }
        }
        
        mainScreen.style.display = 'none';
        chatScreen.style.display = 'block';
        messageInput.focus();
        scrollToBottom();
    }
    
    function getUserEmail() {
        return document.getElementById('email').value.trim();
    }
    
    function displayMessage(message, isSent) {
        console.log('displayMessage called, isSent:', isSent, 'message:', message);
        console.log('messageContainer element:', messageContainer);
        
        if (!messageContainer) {
            console.error('messageContainer is null or undefined!');
            return;
        }
        
        var msgDiv = document.createElement('div');
        msgDiv.className = 'message ' + (isSent ? 'message-sent' : 'message-received');
        console.log('Created msgDiv with className:', msgDiv.className);
        
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        
        if (!isSent) {
            var sender = document.createElement('div');
            sender.className = 'message-sender';
            sender.textContent = message.sender;
            bubble.appendChild(sender);
        }
        
        var text = document.createElement('div');
        text.textContent = message.text;
        bubble.appendChild(text);
        console.log('Message text:', message.text);
        
        var time = document.createElement('div');
        time.className = 'message-time';
        time.textContent = formatTime(message.time);
        bubble.appendChild(time);
        
        msgDiv.appendChild(bubble);
        messageContainer.appendChild(msgDiv);
        console.log('Message appended to messageContainer, total messages:', messageContainer.children.length);
    }
    
    function addSystemMessage(text) {
        var msgDiv = document.createElement('div');
        msgDiv.className = 'message-system';
        msgDiv.textContent = text;
        messageContainer.appendChild(msgDiv);
        scrollToBottom();
    }
    
    // Show typing indicator
    // Doesn't appear in regular use, fix later
    function showTypingIndicator(email) {
        var existingIndicator = document.getElementById('typing-' + email);
        if (existingIndicator) {
            clearTimeout(typingTimers[email]);
        } else {
            var indicator = document.createElement('div');
            indicator.id = 'typing-' + email;
            indicator.className = 'typing-indicator';
            indicator.textContent = 'typing...';
            messageContainer.appendChild(indicator);
            scrollToBottom();
        }
        
        typingTimers[email] = setTimeout(function() {
            var ind = document.getElementById('typing-' + email);
            if (ind) ind.parentNode.removeChild(ind);
            delete typingTimers[email];
        }, 3000);
    }
    
    function formatTime(date) {
        var hours = date.getHours();
        var minutes = date.getMinutes();
        var ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        minutes = minutes < 10 ? '0' + minutes : minutes;
        return hours + ':' + minutes + ' ' + ampm;
    }
    
    function scrollToBottom() {
        setTimeout(function() {
            messageContainer.scrollTop = messageContainer.scrollHeight;
        }, 100);
    }
    
    function handleSendMessage() {
        var text = messageInput.value.trim();
        console.log('handleSendMessage called, text:', text, 'currentContact:', currentContact);
        if (!text || !currentContact) return;

        if (conversationStates[currentContact] !== 'ready') {
            queueMessage(currentContact, text);
            startConversation(currentContact);
            showStatus('Starting conversation...');
            messageInput.value = '';
            return;
        }

        sendChatMessage(currentContact, text);
        messageInput.value = '';
    }
    
    // Send typing notification
    // Seems to be doing some weird shit
    var typingTimeout = null;
    function handleTypingInput() {
        return;
    }
    
    function handleNudgeBtn() {
        if (!currentContact) return;
        
        sendMessage({
            type: 'sendNudge',
            email: currentContact
        });
        
        addSystemMessage('You sent a nudge');
    }
    
    function closeChat() {
        if (currentContact) {
            sendMessage({
                type: 'closeConversation',
                email: currentContact
            });
            delete conversations[currentContact];
            delete conversationStates[currentContact];
            delete queuedMessages[currentContact];
        }
        
        currentContact = null;
        chatScreen.style.display = 'none';
        mainScreen.style.display = 'block';
        adjustContactListHeight();
    }
    
    function handleStatusChange() {
        var status = statusSelect.value;
        console.log('Setting status to:', status);
        sendMessage({
            type: 'setPresence',
            status: status
        });
    }
    
    function handleSetPsm() {
        var message = personalMessageInput.value.trim();
        console.log('Setting personal message to:', message);
        sendMessage({
            type: 'setPersonalMessage',
            message: message
        });
        personalMessageInput.value = '';
    }
    
    function handleAddContact() {
        var email = addContactInput.value.trim();
        if (!email) return;
        
        console.log('[CLIENT] Adding contact:', email);
        sendMessage({
            type: 'addContact',
            email: email
        });
        
        addContactInput.value = '';
        showStatus('Contact request sent');
    }
    
    function handleLogout() {
        sendMessage({
            type: 'logout'
        });
        
        contacts = {};
        conversations = {};
        currentContact = null;
        
        ws.close();
        
        // Reload the page instead of just switching screens
        window.location.reload();
    }

    function handleReload() {
        window.location.reload();
    }
    
    function showError(message) {
        loginError.textContent = message;
        loginError.style.display = 'block';
        loginBtn.disabled = false;
        loginBtn.innerHTML = 'Sign In';
        updateLoginButtonState();
    }
    
    function hideError() {
        loginError.style.display = 'none';
    }
    
    function showStatus(message) {
        loginStatus.textContent = message;
        loginStatus.style.display = 'block';
    }
    
    function hideStatus() {
        loginStatus.style.display = 'none';
    }

    function addClass(el, className) {
        if (!el) return;
        if (el.classList) {
            el.classList.add(className);
            return;
        }

        if ((' ' + el.className + ' ').indexOf(' ' + className + ' ') === -1) {
            el.className = el.className ? el.className + ' ' + className : className;
        }
    }

    function removeClass(el, className) {
        if (!el) return;
        if (el.classList) {
            el.classList.remove(className);
            return;
        }

        el.className = el.className.replace(new RegExp('(^|\\s)' + className + '(?=\\s|$)', 'g'), ' ').replace(/\s+/g, ' ').replace(/^\s|\s$/g, '');
    }

    function updateLoginButtonState() {
        var allFilled = true;
        var emailInput = document.getElementById('email');
        var passwordInput = document.getElementById('password');
        var serviceConfig;

        if (!emailInput.value || !emailInput.value.trim() || !passwordInput.value || !passwordInput.value.trim()) {
            allFilled = false;
        }

        if (allFilled && serviceSelect && !serviceSelect.value) {
            allFilled = false;
        }

        if (allFilled && serviceSelect && serviceSelect.value === 'custom') {
            serviceConfig = getSelectedServiceConfig();
            if (!serviceConfig.server || !serviceConfig.port || !serviceConfig.nexus || !serviceConfig.config) {
                allFilled = false;
            }
        }

        if (allFilled) {
            addClass(loginBtn, 'login-ready');
        } else {
            removeClass(loginBtn, 'login-ready');
        }
    }
    
    // Event listeners
    loginForm.addEventListener('submit', handleLogin);
    loginBtn.addEventListener('click', handleLogin);

    for (var requiredIndex = 0; requiredIndex < requiredLoginInputs.length; requiredIndex++) {
        requiredLoginInputs[requiredIndex].addEventListener('input', updateLoginButtonState);
        requiredLoginInputs[requiredIndex].addEventListener('change', updateLoginButtonState);
        requiredLoginInputs[requiredIndex].addEventListener('keyup', updateLoginButtonState);
    }

    statusSelect.addEventListener('change', handleStatusChange);
    if (serviceSelect) {
        serviceSelect.addEventListener('change', updateServiceFieldsVisibility);
    }
    if (reloadBtn) {
        reloadBtn.addEventListener('click', handleReload);
    }
    logoutBtn.addEventListener('click', handleLogout);
    setPsmBtn.addEventListener('click', handleSetPsm);
    addContactBtn.addEventListener('click', handleAddContact);
    nudgeBtn.addEventListener('click', handleNudgeBtn);
    closeChatBtn.addEventListener('click', closeChat);
    
    // Message input - send on return
    messageInput.addEventListener('keypress', function(e) {
        if (e.keyCode === 13 || e.which === 13) {
            handleSendMessage();
            e.preventDefault();
        }
    });
    
    // Collapsible section toggles
    var togglePsm = document.getElementById('togglePsm');
    var toggleAddContact = document.getElementById('toggleAddContact');
    var psmSection = document.getElementById('psmSection');
    var addContactSection = document.getElementById('addContactSection');
    
    if (togglePsm && psmSection) {
        togglePsm.addEventListener('click', function() {
            var section = togglePsm.parentNode;
            if (psmSection.style.display === 'none') {
                psmSection.style.display = 'block';
                togglePsm.textContent = 'Personal Message ▲';
                if (section && section.classList) section.classList.add('open');
            } else {
                psmSection.style.display = 'none';
                togglePsm.textContent = 'Personal Message ▼';
                if (section && section.classList) section.classList.remove('open');
            }
            adjustContactListHeight();
        });
    }
    
    if (toggleAddContact && addContactSection) {
        toggleAddContact.addEventListener('click', function() {
            var section = toggleAddContact.parentNode;
            if (addContactSection.style.display === 'none') {
                addContactSection.style.display = 'block';
                toggleAddContact.textContent = 'Add Contact ▲';
                if (section && section.classList) section.classList.add('open');
            } else {
                addContactSection.style.display = 'none';
                toggleAddContact.textContent = 'Add Contact ▼';
                if (section && section.classList) section.classList.remove('open');
            }
            adjustContactListHeight();
        });
    }
    
    // Message input handlers
    messageInput.addEventListener('keyup', handleTypingInput);
    
    personalMessageInput.addEventListener('keypress', function(e) {
        if (e.keyCode === 13) {
            handleSetPsm();
            e.preventDefault();
        }
    });
    
    addContactInput.addEventListener('keypress', function(e) {
        if (e.keyCode === 13) {
            handleAddContact();
            e.preventDefault();
        }
    });

    if (serverInput) {
        serverInput.addEventListener('input', updateLoginButtonState);
        serverInput.addEventListener('change', updateLoginButtonState);
        serverInput.addEventListener('keyup', updateLoginButtonState);
    }

    if (nexusInput) {
        nexusInput.addEventListener('input', updateLoginButtonState);
        nexusInput.addEventListener('change', updateLoginButtonState);
        nexusInput.addEventListener('keyup', updateLoginButtonState);
    }

    if (configInput) {
        configInput.addEventListener('input', updateLoginButtonState);
        configInput.addEventListener('change', updateLoginButtonState);
        configInput.addEventListener('keyup', updateLoginButtonState);
    }

    if (forceHttpToggle) {
        forceHttpToggle.addEventListener('change', updateLoginButtonState);
    }

    if (portInput) {
        portInput.addEventListener('input', function() {
            var digitsOnly = this.value.replace(/[^0-9]/g, '');
            if (!digitsOnly) {
                this.value = '';
                return;
            }

            var portNumber = parseInt(digitsOnly, 10);
            if (portNumber > 65535) portNumber = 65535;
            if (portNumber < 1) portNumber = 1;
            this.value = String(portNumber);
        });

        portInput.addEventListener('keypress', function(e) {
            var charCode = e.which || e.keyCode;
            if (charCode === 8 || charCode === 9 || charCode === 13 || charCode === 27 || charCode === 46) {
                return;
            }

            if (charCode < 48 || charCode > 57) {
                e.preventDefault();
            }
        });

        portInput.addEventListener('paste', function(e) {
            var clipboard = e.clipboardData || window.clipboardData;
            if (!clipboard) return;

            var pasted = clipboard.getData('text');
            if (/[^0-9]/.test(pasted)) {
                e.preventDefault();
                this.value = pasted.replace(/[^0-9]/g, '').slice(0, 5);
            }
        });
    }
    
    function adjustContactListHeight() {
        var collapsibleSections = document.querySelector('.collapsible-sections');
        var mainNavbar = document.querySelector('#mainScreen .navbar');
        
        if (collapsibleSections && contactList) {
            var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            var sectionsRect = collapsibleSections.getBoundingClientRect();
            var navbarHeight = mainNavbar ? mainNavbar.offsetHeight : 44;

            // Keep a small bottom gutter so the rounded container is not clipped on old WebKit.
            var bottomGutter = 10;
            var remainingHeight = viewportHeight - sectionsRect.bottom - bottomGutter;

            // When first rendering on mobile Safari, geometry can be stale for one tick.
            // Fallback to navbar-based estimate to avoid tiny initial list heights.
            if (remainingHeight < 120) {
                remainingHeight = viewportHeight - navbarHeight - collapsibleSections.offsetHeight - 30;
            }

            if (remainingHeight < 180) remainingHeight = 180;
            contactList.style.height = remainingHeight + 'px';
        }
    }
    
    // Init
    updateServiceFieldsVisibility();
    updateLoginButtonState();
    adjustContactListHeight();

    setTimeout(adjustContactListHeight, 50);
    setTimeout(adjustContactListHeight, 250);
    
    // Adjust on window resize
    window.addEventListener('resize', adjustContactListHeight);
    window.addEventListener('orientationchange', adjustContactListHeight);
    window.addEventListener('load', adjustContactListHeight);
    
})();
