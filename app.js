/*
* SecureChat App Logic
* This file handles all the client-side logic for the SecureChat app.
* It works with the Firebase SDK (imported in index.html) and manipulates the DOM.
*/
//updates done here
// Import necessary Firebase functions (these are available globally from the script in index.html)
const {
    getFirestore, doc, addDoc, collection, onSnapshot, query,
    serverTimestamp, getDoc, setDoc, updateDoc, getDocs, deleteDoc, writeBatch
} = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");

// --- Global Variables ---
let db, auth, currentUserId, userName;
let currentRoom = null;
let unsubscribeMessages = null; // To stop listening to messages
let unsubscribeUsers = null; // To stop listening to users
let unsubscribeTyping = null; // To stop listening to typing indicators
let isNavigating = false; // Prevents hashchange loop
let usersInRoom = new Map(); // Local cache of users
let isWindowActive = true; // Track if window is focused
let unreadMessages = 0; // Track unread message count
let messageCache = new Map(); // Cache rendered messages to avoid re-rendering
let typingTimeout = null; // For typing indicators
let isTyping = false; // Track if user is typing
let typingUsers = new Set(); // Track users who are typing
let typingIndicatorTimeout = null; // Clear typing indicator after inactivity
let isInitialMessageLoad = true; // Track if this is the first message load
let beforeUnloadHandler = null; // Store the beforeunload handler reference
let heartbeatInterval = null; // Heartbeat to keep presence alive
let presenceCleanupInterval = null; // Cleanup stale user sessions

// --- DOM Element Cache ---
// We'll get these elements once the app initializes
let dom = {};

/**
 * Initializes the application logic, wires up event listeners, and starts the app.
 * This function is called from index.html after Firebase is initialized.
 * @param {object} firestoreDB - The initialized Firestore instance.
 * @param {object} firebaseAuth - The initialized Auth instance.
 * @param {string} uid - The authenticated user's ID.
 */
export function initializeAppLogic(firestoreDB, firebaseAuth, uid) {
    db = firestoreDB;
    auth = firebaseAuth;
    currentUserId = uid;

    // Cache all DOM elements for quick access
    dom = {
        loadingSpinner: document.getElementById('loading-spinner'),
        roomSelectionUI: document.getElementById('room-selection-ui'),
        nameSelectionUI: document.getElementById('name-selection-ui'),
        chatUI: document.getElementById('chat-ui'),
        passwordVerifyUI: document.getElementById('password-verify-ui'),

        roomForm: document.getElementById('room-form'),
        roomInput: document.getElementById('room-input'),
        roomPasswordInput: document.getElementById('room-password-input'),
        roomError: document.getElementById('room-error'),

        passwordVerifyForm: document.getElementById('password-verify-form'),
        passwordVerifyInput: document.getElementById('password-verify-input'),
        passwordError: document.getElementById('password-error'),
        backToRoomsBtn: document.getElementById('back-to-rooms-btn'),

        nameForm: document.getElementById('name-form'),
        nameInput: document.getElementById('name-input'),
        nameError: document.getElementById('name-error'),

        messageForm: document.getElementById('message-form'),
        messageInput: document.getElementById('message-input'),
        messageList: document.getElementById('message-list'),
        chatRoomDisplay: document.getElementById('chat-room-display'),

        sidebar: document.getElementById('sidebar'),
        sidebarOverlay: document.getElementById('sidebar-overlay'),
        sidebarToggleBtn: document.getElementById('sidebar-toggle-btn'),
        userList: document.getElementById('user-list'),
        userCount: document.getElementById('user-count'),

        deleteChatBtn: document.getElementById('delete-chat-btn'),
        leaveChatHeaderBtn: document.getElementById('leave-chat-header-btn'),
        deleteModal: document.getElementById('delete-modal'),
        cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
        confirmDeleteBtn: document.getElementById('confirm-delete-btn'),
    };

    // Wire up all event listeners
    setupEventListeners();

    // Check for saved room session first
    checkSavedSession();
    
    // Check the URL hash to see if we're joining a room
    handleHashChange();
}

/**
 * Checks if there's a saved room session and restores it.
 * Always restores to password page for security - user must re-authenticate.
 */
function checkSavedSession() {
    try {
        const savedRoom = sessionStorage.getItem('securechat_lastRoom');
        if (savedRoom && !window.location.hash) {
            // There's a saved room and no hash in URL - restore to password page
            // User must re-enter password for security
            currentRoom = savedRoom;
            isNavigating = true;
            window.location.hash = savedRoom;
            // This will trigger verifyRoomExists which shows password page
        }
    } catch (error) {
        console.error('Error checking saved session:', error);
    }
}

/**
 * Attaches all the necessary event listeners for the app.
 */
function setupEventListeners() {
    // Listen for hash changes (e.g., joining a room from a link)
    window.addEventListener('hashchange', handleHashChange);

    // Forms
    dom.roomForm.addEventListener('submit', handleRoomFormSubmit);
    dom.passwordVerifyForm.addEventListener('submit', handlePasswordVerifySubmit);
    dom.nameForm.addEventListener('submit', handleNameFormSubmit);
    dom.messageForm.addEventListener('submit', handleMessageFormSubmit);

    // Buttons
    dom.backToRoomsBtn.addEventListener('click', () => {
        // Clear saved room session when going back
        try {
            sessionStorage.removeItem('securechat_lastRoom');
        } catch (error) {
            console.error('Error clearing sessionStorage:', error);
        }
        window.location.hash = '';
    });
    dom.sidebarToggleBtn.addEventListener('click', toggleSidebar);
    dom.sidebarOverlay.addEventListener('click', toggleSidebar);
    dom.leaveChatHeaderBtn.addEventListener('click', handleLeaveRoom);
    dom.deleteChatBtn.addEventListener('click', () => dom.deleteModal.classList.remove('hidden'));
    dom.cancelDeleteBtn.addEventListener('click', () => dom.deleteModal.classList.add('hidden'));
    dom.confirmDeleteBtn.addEventListener('click', handleDeleteChat);

    // Title notifications
    window.addEventListener('blur', () => {
        isWindowActive = false;
    });
    window.addEventListener('focus', () => {
        isWindowActive = true;
        unreadMessages = 0;
        document.title = "SecureChat";
    });
    
    // Request notification permission on first interaction
    if ('Notification' in window && Notification.permission === 'default') {
        // Request permission after a short delay to avoid blocking
        setTimeout(() => {
            Notification.requestPermission().catch(err => {
                console.log('Notification permission request failed:', err);
            });
        }, 1000);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
    
    // Typing indicator
    dom.messageInput.addEventListener('input', handleTypingIndicator);
    dom.messageInput.addEventListener('blur', stopTypingIndicator);
    
    // Auto-resize message input
    dom.messageInput.addEventListener('input', autoResizeInput);
    
    // Prevent form submission on Enter+Shift (for multi-line)
    dom.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            const start = dom.messageInput.selectionStart;
            const end = dom.messageInput.selectionEnd;
            dom.messageInput.value = dom.messageInput.value.substring(0, start) + '\n' + dom.messageInput.value.substring(end);
            dom.messageInput.selectionStart = dom.messageInput.selectionEnd = start + 1;
            autoResizeInput();
        }
    });
}

// --- UI State Management ---

/**
 * Controls which "page" of the app is visible.
 * @param {string} state - The UI state to show ('room', 'password', 'name', 'chat', 'loading').
 */
function showUI(state) {
    // Hide all major UI components
    dom.loadingSpinner.classList.add('hidden');
    dom.roomSelectionUI.classList.add('hidden');
    dom.nameSelectionUI.classList.add('hidden');
    dom.chatUI.classList.add('hidden');
    dom.passwordVerifyUI.classList.add('hidden');

    // Hide chat-specific header buttons
    dom.sidebarToggleBtn.classList.add('hidden');
    dom.deleteChatBtn.classList.add('hidden');
    dom.leaveChatHeaderBtn.classList.add('hidden');
    dom.chatRoomDisplay.textContent = '';
    
    // Show the specific UI
    switch (state) {
        case 'loading':
            dom.loadingSpinner.classList.remove('hidden');
            break;
        case 'room':
            dom.roomSelectionUI.classList.remove('hidden');
            break;
        case 'password':
            dom.passwordVerifyUI.classList.remove('hidden');
            dom.chatRoomDisplay.textContent = `Room: ${currentRoom}`;
            break;
        case 'name':
            dom.nameSelectionUI.classList.remove('hidden');
            dom.chatRoomDisplay.textContent = `Room: ${currentRoom}`;
            break;
        case 'chat':
            dom.chatUI.classList.remove('hidden');
            dom.chatRoomDisplay.textContent = `Room: ${currentRoom}`;
            // Show the buttons in the header that are for the chat
            dom.sidebarToggleBtn.classList.remove('hidden');
            dom.deleteChatBtn.classList.remove('hidden');
            dom.leaveChatHeaderBtn.classList.remove('hidden');
            break;
    }
}

/**
 * Toggles the visibility of the user sidebar.
 */
function toggleSidebar() {
    const isHidden = dom.sidebar.classList.contains('-translate-x-full');
    dom.sidebar.classList.toggle('-translate-x-full');
    dom.sidebarOverlay.classList.toggle('hidden');
    
    // Prevent body scroll when sidebar is open on mobile
    if (!isHidden) {
        document.body.style.overflow = '';
    } else {
        document.body.style.overflow = 'hidden';
    }
}

// --- Core App Logic (Joining/Leaving) ---

/**
 * Handles the URL hash change. This is the main router for the app.
 */
function handleHashChange() {
    if (isNavigating) {
        isNavigating = false; // Reset lock
        return;
    }

    // Stop listening to any old room
    cleanupSubscriptions();
    
    const hash = window.location.hash.substring(1);
    if (hash) {
        currentRoom = hash;
        // Check if room exists and requires a password
        verifyRoomExists(hash);
    } else {
        // No room in hash, check if we should restore saved session
        const savedRoom = sessionStorage.getItem('securechat_lastRoom');
        if (savedRoom) {
            // Restore to password page for saved room
            currentRoom = savedRoom;
            isNavigating = true;
            window.location.hash = savedRoom;
            return;
        }
        
        // No saved room, go to room selection
        currentRoom = null;
        userName = null;
        showUI('room');
        // Clear all inputs
        dom.roomInput.value = '';
        dom.roomPasswordInput.value = '';
        dom.passwordVerifyInput.value = '';
        dom.nameInput.value = '';
    }
}

/**
 * Checks if a room exists in Firestore and shows the password screen.
 * @param {string} roomName - The name of the room to check.
 */
async function verifyRoomExists(roomName) {
    showUI('loading');
    try {
        const roomDocRef = doc(db, 'chat-rooms', roomName);
        const roomSnap = await getDoc(roomDocRef);

        if (roomSnap.exists()) {
            // Room exists, ask for password
            showUI('password');
            dom.passwordVerifyInput.focus();
        } else {
            // Room doesn't exist
            showError(dom.roomError, "Room not found. You can create it.");
            window.location.hash = ''; // Go back to room selection
        }
    } catch (error) {
        console.error("Error checking room:", error);
        showError(dom.roomError, "An error occurred.");
        window.location.hash = '';
    }
}

/**
 * Handles the "Create or Join Room" form submission.
 */
async function handleRoomFormSubmit(e) {
    e.preventDefault();
    showError(dom.roomError, '', true); // Clear error
    const roomName = dom.roomInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const password = dom.roomPasswordInput.value.trim();

    if (!roomName || !password) {
        showError(dom.roomError, "Room name and password are required.");
        return;
    }

    showUI('loading');

    try {
        const passwordHash = await hashPassword(password);
        const roomDocRef = doc(db, 'chat-rooms', roomName);
        const roomSnap = await getDoc(roomDocRef);

        if (roomSnap.exists()) {
            // Room exists, check password
            if (roomSnap.data().passwordHash === passwordHash) {
                // Password matches, save room and navigate to name screen
                currentRoom = roomName;
                try {
                    sessionStorage.setItem('securechat_lastRoom', currentRoom);
                } catch (error) {
                    console.error('Error saving room to sessionStorage:', error);
                }
                isNavigating = true; // Set lock
                window.location.hash = roomName; // Set hash
                showUI('name'); // Show name UI *before* hashchange fires
                dom.nameInput.focus();
            } else {
                showError(dom.roomError, "Invalid password for this room.");
                showUI('room'); // Go back to room UI
            }
        } else {
            // Room doesn't exist, create it
            await setDoc(roomDocRef, {
                passwordHash: passwordHash,
                createdAt: serverTimestamp()
            });
            // Room created, save room and navigate to name screen
            currentRoom = roomName;
            try {
                sessionStorage.setItem('securechat_lastRoom', currentRoom);
            } catch (error) {
                console.error('Error saving room to sessionStorage:', error);
            }
            isNavigating = true; // Set lock
            window.location.hash = roomName; // Set hash
            showUI('name'); // Show name UI
            dom.nameInput.focus();
        }
    } catch (error) {
        console.error("Error creating/joining room:", error);
        showError(dom.roomError, "An error occurred. Please try again.");
        showUI('room');
    }
}

/**
 * Handles the password verification form (for users joining via URL).
 */
async function handlePasswordVerifySubmit(e) {
    e.preventDefault();
    showError(dom.passwordError, '', true); // Clear error
    const password = dom.passwordVerifyInput.value.trim();
    if (!password || !currentRoom) return;

    showUI('loading');

    try {
        const passwordHash = await hashPassword(password);
        const roomDocRef = doc(db, 'chat-rooms', currentRoom);
        const roomSnap = await getDoc(roomDocRef);

        if (roomSnap.exists() && roomSnap.data().passwordHash === passwordHash) {
            // Password is correct! Save room to sessionStorage and show name selection.
            try {
                sessionStorage.setItem('securechat_lastRoom', currentRoom);
            } catch (error) {
                console.error('Error saving room to sessionStorage:', error);
            }
            showUI('name');
            dom.nameInput.focus();
        } else {
            showError(dom.passwordError, "Invalid password. Please try again.");
            showUI('password'); // Show password UI again
        }
    } catch (error) {
        console.error("Error verifying password:", error);
        showError(dom.passwordError, "An error occurred.");
        showUI('password');
    }
}

/**
 * Handles the "Enter Your Name" form submission.
 */
async function handleNameFormSubmit(e) {
    e.preventDefault();
    showError(dom.nameError, '', true); // Clear error
    const name = dom.nameInput.value.trim();
    if (!name || !currentRoom) return;

    showUI('loading');

    try {
        // Check if name is already taken *by another user*
        const usersCol = collection(db, 'chat-rooms', currentRoom, 'users');
        const q = query(usersCol);
        const querySnapshot = await getDocs(q);
        
        let nameIsTaken = false;
        let existingUserDoc = null; // To check if we are re-joining

        querySnapshot.forEach(doc => {
            if (doc.data().name.toLowerCase() === name.toLowerCase()) {
                if (doc.id !== currentUserId) {
                    nameIsTaken = true; // Taken by someone else
                } else {
                    existingUserDoc = doc; // This is our "ghost"
                }
            }
        });

        if (nameIsTaken) {
            showError(dom.nameError, "This name is already in use. Please choose another.");
            showUI('name');
            return;
        }

        userName = name; // Set global user name
        const userDocRef = doc(db, 'chat-rooms', currentRoom, 'users', currentUserId);

        // Check if user recently left (by checking recent messages)
        let wasRejoining = false;
        if (!existingUserDoc) {
            // User document doesn't exist, check if they recently left
            const messagesCol = collection(db, 'chat-rooms', currentRoom, 'messages');
            const recentMessagesQuery = query(messagesCol);
            const recentSnapshot = await getDocs(recentMessagesQuery);
            
            // Check last 50 messages for a "left" message with this name
            const recentMessages = [];
            recentSnapshot.forEach(doc => {
                recentMessages.push(doc.data());
            });
            
            // Sort by timestamp and check most recent
            recentMessages.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
            
            // Check if there's a recent "left" message for this user (within last 5 minutes)
            const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
            for (const msg of recentMessages.slice(0, 50)) {
                if (msg.type === 'event' && 
                    msg.text && 
                    msg.text.includes(`${userName} has left the room.`) &&
                    msg.timestamp?.seconds > fiveMinutesAgo) {
                    wasRejoining = true;
                    break;
                }
            }
        }

        if (existingUserDoc) {
            // This is us re-joining (document still exists - maybe page refresh).
            // Just update the timestamp.
            await updateDoc(userDocRef, {
                joined: serverTimestamp(), // Update joined time
                lastActive: serverTimestamp() // Update last active time
            });
            // Post "rejoined" message
            await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
                type: 'event',
                text: `${userName} has rejoined the room.`,
                timestamp: serverTimestamp(),
                senderId: 'system'
            });
        } else {
            // This is a new user or a new name.
            await setDoc(userDocRef, {
                name: userName,
                joined: serverTimestamp(),
                lastActive: serverTimestamp() // Track when user was last active for heartbeat cleanup
            });

            // Post appropriate message
            if (wasRejoining) {
                await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
                    type: 'event',
                    text: `${userName} has rejoined the room.`,
                    timestamp: serverTimestamp(),
                    senderId: 'system'
                });
            } else {
                await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
                    type: 'event',
                    text: `${userName} has joined the room.`,
                    timestamp: serverTimestamp(),
                    senderId: 'system'
                });
            }
        }

        // Successfully joined - save room to sessionStorage for future returns
        try {
            sessionStorage.setItem('securechat_lastRoom', currentRoom);
        } catch (error) {
            console.error('Error saving room to sessionStorage:', error);
        }
        
        // Successfully joined
        showUI('chat');
        isInitialMessageLoad = true; // Reset flag for initial load
        dom.messageInput.focus();
        listenForMessages();
        listenForUsers();
        listenForTyping();
        
        // Start heartbeat to keep presence alive
        startPresenceHeartbeat();
        
        // Start cleanup process to remove stale users
        startPresenceCleanup();
        
        // Set up beforeunload handler to clean up when user closes tab/window
        setupBeforeUnloadHandler();

    } catch (error) {
        console.error("Error joining chat:", error);
        showError(dom.nameError, "An error occurred while joining.");
        showUI('name');
    }
}

/**
 * Handles leaving the room when the header button is clicked.
 */
async function handleLeaveRoom() {
    await cleanupUserPresence();
    // Clear saved room session
    try {
        sessionStorage.removeItem('securechat_lastRoom');
    } catch (error) {
        console.error('Error clearing sessionStorage:', error);
    }
    window.location.hash = ''; // This triggers handleHashChange
}

/**
 * Cleans up user presence from the room (called on leave or beforeunload).
 * This marks the user as having left the room.
 * Uses synchronous sendBeacon API for reliability during page unload.
 */
async function cleanupUserPresence() {
    if (!currentRoom || !userName || !currentUserId) return;

    // Hide sidebar if open
    if (dom.sidebar) {
        dom.sidebar.classList.add('-translate-x-full');
    }
    if (dom.sidebarOverlay) {
        dom.sidebarOverlay.classList.add('hidden');
    }

    try {
        // 1. Stop typing indicator first
        stopTypingIndicator();
        
        // 2. Stop heartbeat immediately
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        // 3. Delete user from the 'users' collection
        const userDocRef = doc(db, 'chat-rooms', currentRoom, 'users', currentUserId);
        await deleteDoc(userDocRef);

        // 4. Post "User has left" message
        await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
            type: 'event',
            text: `${userName} has left the room.`,
            timestamp: serverTimestamp(),
            senderId: 'system'
        });

    } catch (error) {
        console.error("Error cleaning up user presence:", error);
        // Note: If this fails during page unload, that's okay - 
        // the heartbeat cleanup will remove stale sessions
    }
}

/**
 * Starts a heartbeat to keep the user's presence alive and update lastActive timestamp.
 * This helps detect when users disconnect without proper cleanup (e.g., browser crash).
 */
function startPresenceHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    if (!currentRoom || !currentUserId) return;
    
    // Update user's lastActive timestamp every 10 seconds
    heartbeatInterval = setInterval(async () => {
        if (!currentRoom || !currentUserId || !userName) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            return;
        }
        
        try {
            const userDocRef = doc(db, 'chat-rooms', currentRoom, 'users', currentUserId);
            await updateDoc(userDocRef, {
                lastActive: serverTimestamp()
            });
        } catch (error) {
            console.error("Error updating heartbeat:", error);
        }
    }, 10000); // Update every 10 seconds
}

/**
 * Starts a cleanup process to remove stale user sessions.
 * Removes users who haven't had a heartbeat update in the last 60 seconds.
 */
function startPresenceCleanup() {
    if (presenceCleanupInterval) {
        clearInterval(presenceCleanupInterval);
    }
    
    if (!currentRoom) return;
    
    // Check for stale users every 30 seconds
    presenceCleanupInterval = setInterval(async () => {
        if (!currentRoom) {
            clearInterval(presenceCleanupInterval);
            presenceCleanupInterval = null;
            return;
        }
        
        try {
            const usersCol = collection(db, 'chat-rooms', currentRoom, 'users');
            const q = query(usersCol);
            const snapshot = await getDocs(q);
            
            const now = Math.floor(Date.now() / 1000);
            const staleThreshold = 60; // 60 seconds
            
            snapshot.forEach(async (userDoc) => {
                const userData = userDoc.data();
                const lastActive = userData.lastActive?.seconds || userData.joined?.seconds || 0;
                
                // If user hasn't been active for 60+ seconds, they're likely disconnected
                if (now - lastActive > staleThreshold) {
                    try {
                        // Remove the stale user
                        await deleteDoc(userDoc.ref);
                        
                        // Add a system message
                        if (userData.name) {
                            await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
                                type: 'event',
                                text: `${userData.name} has disconnected.`,
                                timestamp: serverTimestamp(),
                                senderId: 'system'
                            });
                        }
                    } catch (error) {
                        console.error("Error removing stale user:", error);
                    }
                }
            });
        } catch (error) {
            console.error("Error cleaning up stale users:", error);
        }
    }, 30000); // Check every 30 seconds
}

/**
 * Sets up the beforeunload handler to clean up when user closes tab/window.
 * Uses sendBeacon API for more reliable delivery during unload.
 */
function setupBeforeUnloadHandler() {
    // Remove existing handler if any
    if (beforeUnloadHandler) {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        window.removeEventListener('pagehide', beforeUnloadHandler);
    }
    
    // Create handler for pagehide (fires on actual page unload)
    // pagehide is more reliable than beforeunload, especially on mobile
    beforeUnloadHandler = (e) => {
        // Clean up user presence when closing tab/window
        if (currentRoom && userName && currentUserId) {
            // Stop heartbeat immediately
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            if (presenceCleanupInterval) {
                clearInterval(presenceCleanupInterval);
                presenceCleanupInterval = null;
            }
            
            // Try to clean up via Firestore (fire-and-forget)
            cleanupUserPresence().catch(err => {
                console.error('Error in beforeunload cleanup:', err);
            });
        }
    };
    
    // Use pagehide as primary (more reliable, especially on mobile)
    window.addEventListener('pagehide', beforeUnloadHandler);
    // Use beforeunload as backup
    window.addEventListener('beforeunload', beforeUnloadHandler);
}

// --- Chat Functionality ---

/**
 * Listens for new messages in the current room.
 */
function listenForMessages() {
    if (unsubscribeMessages) unsubscribeMessages(); // Stop old listener

    const messagesCol = collection(db, 'chat-rooms', currentRoom, 'messages');
    const q = query(messagesCol); // No 'orderBy', we sort client-side

    unsubscribeMessages = onSnapshot(q, (snapshot) => {
        // Handle connection state
        if (snapshot.metadata.fromCache) {
            // Data is from cache, might be offline
            console.log('Reading from cache - might be offline');
        }
        
        let messages = [];
        let isInitialSnapshot = isInitialMessageLoad;

        snapshot.docChanges().forEach(change => {
            const msgData = { id: change.doc.id, ...change.doc.data() };
            if (change.type === 'added') {
                messages.push(msgData);
                // Handle title notification and browser notification
                // Only show notifications for new messages after initial load
                if (!isInitialSnapshot && msgData.senderId !== currentUserId && !isWindowActive) {
                    unreadMessages++;
                    document.title = `(${unreadMessages}) SecureChat`;
                    
                    // Request browser notification permission and show notification
                    if ('Notification' in window && Notification.permission === 'granted') {
                        try {
                            new Notification(`${msgData.name || 'Someone'} sent a message`, {
                                body: msgData.text?.substring(0, 100) || 'New message',
                                icon: '/favicon.ico',
                                tag: 'securechat-message',
                                requireInteraction: false
                            });
                        } catch (err) {
                            // Notification failed, ignore
                        }
                    }
                }
            } else if (change.type === 'modified') {
                // Handle timestamp updates for our own messages
                if (msgData.senderId === currentUserId) {
                    const msgElement = document.querySelector(`[data-id="${change.doc.id}"] .chat-timestamp`);
                    if (msgElement) {
                        msgElement.textContent = formatTimestamp(msgData.timestamp);
                    }
                }
            } else if (change.type === 'removed') {
                const msgElement = document.querySelector(`[data-id="${change.doc.id}"]`);
                if (msgElement) {
                    msgElement.classList.add('animate-fade-out');
                    setTimeout(() => {
                        msgElement.remove();
                        messageCache.delete(change.doc.id);
                    }, 300);
                }
            }
        });

        // Sort all new messages by timestamp
        if (messages.length > 0) {
            messages.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
            renderMessages(messages, 'added', isInitialSnapshot);
        }
        
        // After initial load, mark as complete and force scroll to bottom
        if (isInitialSnapshot) {
            isInitialMessageLoad = false;
            // Force scroll to bottom after initial messages are rendered
            setTimeout(() => {
                scrollToBottom(true);
            }, 100);
        }
        
        // Hide connection error if messages are loading successfully
        hideConnectionError();
        
    }, (error) => {
        console.error("Error listening for messages:", error);
        // Show connection error notification
        showConnectionError();
    });
}

/**
 * Listens for changes in the user list.
 */
function listenForUsers() {
    if (unsubscribeUsers) unsubscribeUsers();

    const usersCol = collection(db, 'chat-rooms', currentRoom, 'users');
    const q = query(usersCol); // No 'orderBy', we sort client-side

    unsubscribeUsers = onSnapshot(q, (snapshot) => {
        usersInRoom.clear(); // Clear local cache
        let users = [];
        snapshot.forEach(doc => {
            const userData = { id: doc.id, ...doc.data() };
            usersInRoom.set(userData.id, userData);
            users.push(userData);
        });

        // Sort by join time
        users.sort((a, b) => (a.joined?.seconds || 0) - (b.joined?.seconds || 0));

        renderUserList(users);
        
        // Hide connection error if users are loading successfully
        hideConnectionError();

    }, (error) => {
        console.error("Error listening for users:", error);
        showConnectionError();
    });
}

/**
 * Listens for typing indicators from other users.
 */
function listenForTyping() {
    if (unsubscribeTyping) unsubscribeTyping();
    if (!currentRoom) return;
    
    const typingCol = collection(db, 'chat-rooms', currentRoom, 'typing');
    const q = query(typingCol);
    
    unsubscribeTyping = onSnapshot(q, (snapshot) => {
        typingUsers.clear();
        snapshot.forEach(doc => {
            if (doc.id !== currentUserId) {
                const typingData = doc.data();
                // Only show typing if it's recent (within last 5 seconds)
                const typingTime = typingData.timestamp?.seconds || 0;
                const now = Math.floor(Date.now() / 1000);
                if (now - typingTime < 5) {
                    typingUsers.add(typingData.name || 'Someone');
                }
            }
        });
        
        renderTypingIndicator();
    }, (error) => {
        console.error("Error listening for typing:", error);
    });
}

/**
 * Renders the typing indicator below the message list.
 */
function renderTypingIndicator() {
    // Remove existing typing indicator
    let existingIndicator = document.getElementById('typing-indicator');
    if (existingIndicator) {
        existingIndicator.remove();
    }
    
    if (typingUsers.size > 0) {
        const typingArray = Array.from(typingUsers);
        let typingText = '';
        
        if (typingArray.length === 1) {
            typingText = `${typingArray[0]} is typing...`;
        } else if (typingArray.length === 2) {
            typingText = `${typingArray[0]} and ${typingArray[1]} are typing...`;
        } else {
            typingText = `${typingArray[0]} and ${typingArray.length - 1} others are typing...`;
        }
        
        const indicator = document.createElement('div');
        indicator.id = 'typing-indicator';
        indicator.classList.add('text-gray-400', 'text-sm', 'italic', 'px-4', 'py-2', 'animate-pulse', 'mb-2');
        indicator.textContent = typingText;
        
        // Insert before the message form
        const messageForm = dom.messageForm;
        if (messageForm && messageForm.parentElement) {
            messageForm.parentElement.insertBefore(indicator, messageForm);
        }
    }
}

/**
 * Renders messages to the chat window.
 * @param {Array} messages - An array of message objects to render.
 * @param {string} type - 'added' or 'all'. 'added' appends, 'all' overwrites.
 * @param {boolean} forceScroll - If true, force scroll to bottom (for initial load).
 */
function renderMessages(messages, type, forceScroll = false) {
    if (type === 'all') {
        dom.messageList.innerHTML = '';
        messageCache.clear();
    }
    
    const shouldScroll = forceScroll || (dom.messageList.scrollTop + dom.messageList.clientHeight >= dom.messageList.scrollHeight - 30);

    messages.forEach(msg => {
        // Skip if message already rendered (use cache)
        if (messageCache.has(msg.id)) {
            return;
        }
        
        const isSelf = msg.senderId === currentUserId;
        const isSystem = msg.senderId === 'system';

        const messageWrapper = document.createElement('div');
        messageWrapper.setAttribute('data-id', msg.id);
        messageWrapper.classList.add('message-item', 'animate-fade-in');

        if (isSystem) {
            // System message (joined/left/deleted)
            messageWrapper.classList.add('text-center', 'text-gray-400', 'text-sm', 'my-2');
            messageWrapper.textContent = msg.text;
        } else {
            // User message
            messageWrapper.classList.add('flex', 'w-full', 'mb-3', isSelf ? 'justify-end' : 'justify-start');
            
            const messageBubble = document.createElement('div');
            messageBubble.classList.add(
                'max-w-xs',
                'md:max-w-md',
                'p-3',
                'rounded-lg',
                'shadow-lg',
                'transition-all',
                'hover:shadow-xl',
                isSelf ? 'bg-blue-600' : 'bg-gray-600'
            );
            
            const senderName = document.createElement('div');
            senderName.classList.add('font-bold', 'text-sm', 'mb-1', 'opacity-90');
            senderName.textContent = msg.name || 'Anonymous';
            
            const messageText = document.createElement('div');
            messageText.classList.add('text-white', 'break-words', 'whitespace-pre-wrap');
            // Escape HTML to prevent XSS
            const textNode = document.createTextNode(msg.text || '');
            messageText.appendChild(textNode);

            const timestamp = document.createElement('div');
            timestamp.classList.add('text-xs', 'text-gray-300', 'mt-1', 'text-right', 'chat-timestamp', 'opacity-75');
            timestamp.textContent = formatTimestamp(msg.timestamp);

            messageBubble.appendChild(senderName);
            messageBubble.appendChild(messageText);
            messageBubble.appendChild(timestamp);
            messageWrapper.appendChild(messageBubble);
        }
        
        // Cache the rendered message
        messageCache.set(msg.id, messageWrapper);
        dom.messageList.appendChild(messageWrapper);
    });

    // Auto-scroll to bottom if user was already at the bottom or if forced (initial load)
    if (shouldScroll) {
        scrollToBottom(!forceScroll); // Use smooth scroll only if not initial load
    }
}

/**
 * Scrolls the message list to the bottom.
 * @param {boolean} smooth - Whether to use smooth scrolling.
 */
function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
        if (dom.messageList.scrollTo && smooth) {
            dom.messageList.scrollTo({
                top: dom.messageList.scrollHeight,
                behavior: 'smooth'
            });
        } else {
            // Instant scroll for initial load
            dom.messageList.scrollTop = dom.messageList.scrollHeight;
        }
    });
}

/**
 * Renders the list of users in the sidebar.
 * @param {Array} users - An array of user objects.
 */
function renderUserList(users) {
    dom.userList.innerHTML = ''; // Clear list
    dom.userCount.textContent = `(${users.length})`;

    users.forEach(user => {
        const li = document.createElement('li');
        li.classList.add('flex', 'items-center', 'gap-2', 'p-2', 'rounded', 'bg-gray-800');
        
        const statusDot = document.createElement('span');
        statusDot.classList.add('w-3', 'h-3', 'bg-green-500', 'rounded-full', 'flex-shrink-0');
        
        const userName = document.createElement('span');
        userName.classList.add('text-white', 'truncate');
        userName.textContent = user.name;
        
        if (user.id === currentUserId) {
            userName.textContent += ' (You)';
            userName.classList.add('font-bold');
        }

        li.appendChild(statusDot);
        li.appendChild(userName);
        dom.userList.appendChild(li);
    });
}

/**
 * Handles the message sending form.
 */
async function handleMessageFormSubmit(e) {
    e.preventDefault();
    const text = dom.messageInput.value.trim();

    if (text && currentRoom && userName && currentUserId) {
        // Stop typing indicator
        stopTypingIndicator();
        
        dom.messageInput.value = ''; // Clear input immediately
        autoResizeInput(); // Reset input height
        
        try {
            const collectionPath = `chat-rooms/${currentRoom}/messages`;
            await addDoc(collection(db, collectionPath), {
                name: userName,
                text: text,
                senderId: currentUserId,
                timestamp: serverTimestamp()
            });
        } catch (error) {
            console.error("Error sending message:", error);
            dom.messageInput.value = text; // Put message back on error
            autoResizeInput();
            // Show a temporary error notification
            const errorNotification = document.createElement('div');
            errorNotification.className = 'fixed top-4 right-4 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg z-50 animate-fade-in';
            errorNotification.textContent = 'Failed to send message. Please try again.';
            document.body.appendChild(errorNotification);
            setTimeout(() => {
                errorNotification.classList.add('animate-fade-out');
                setTimeout(() => errorNotification.remove(), 300);
            }, 3000);
        }
    }
}

/**
 * Handles the "Delete Chat" button click. Deletes all messages.
 */
async function handleDeleteChat() {
    if (!currentRoom) return;

    dom.deleteModal.classList.add('hidden'); // Hide modal
    showUI('loading'); // Show spinner

    try {
        const collectionPath = `chat-rooms/${currentRoom}/messages`;
        const messagesCol = collection(db, collectionPath);
        const q = query(messagesCol);
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            showUI('chat');
            return;
        }

        // Use a batch write for atomic delete
        const batch = writeBatch(db);
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Clear local messages immediately
        dom.messageList.innerHTML = '';

        // Add a system message
        await addDoc(collection(db, collectionPath), {
            type: 'event',
            text: `${userName} cleared the chat history.`,
            timestamp: serverTimestamp(),
            senderId: 'system'
        });
        
        // No need to re-listen, the 'added' event for the system message
        // will be caught by the active listener.

    } catch (error) {
        console.error("Error deleting chat:", error);
    } finally {
        showUI('chat');
    }
}

// --- Utility Functions ---

/**
 * Stops all active Firestore listeners.
 */
function cleanupSubscriptions() {
    if (unsubscribeMessages) {
        unsubscribeMessages();
        unsubscribeMessages = null;
    }
    if (unsubscribeUsers) {
        unsubscribeUsers();
        unsubscribeUsers = null;
    }
    if (unsubscribeTyping) {
        unsubscribeTyping();
        unsubscribeTyping = null;
    }
    
    // Stop typing indicator
    stopTypingIndicator();
    typingUsers.clear();
    const existingIndicator = document.getElementById('typing-indicator');
    if (existingIndicator) {
        existingIndicator.remove();
    }
    
    // Stop heartbeat and cleanup intervals
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (presenceCleanupInterval) {
        clearInterval(presenceCleanupInterval);
        presenceCleanupInterval = null;
    }
    
    // Remove beforeunload handler
    if (beforeUnloadHandler) {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        window.removeEventListener('pagehide', beforeUnloadHandler);
        beforeUnloadHandler = null;
    }
}

/**
 * Displays an error message in a specified error element.
 * @param {HTMLElement} el - The DOM element to show the error in.
 * @param {string} message - The error message.
 * @param {boolean} [hide=false] - If true, just hides the element.
 */
function showError(el, message, hide = false) {
    if (hide) {
        el.classList.add('hidden');
    } else {
        el.textContent = message;
        el.classList.remove('hidden');
    }
}

/**
 * Hashes a string using SHA-256 (for passwords).
 * @param {string} password - The password to hash.
 * @returns {Promise<string>} The SHA-256 hash as a hex string.
 */
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

/**
 * Formats a Firebase timestamp into a human-readable time (e.g., "10:52 AM").
 * @param {object} timestamp - The Firebase timestamp object.
 * @returns {string} The formatted time.
 */
function formatTimestamp(timestamp) {
    if (!timestamp) {
        return '...'; // Show ... while server timestamp is pending
    }
    const date = timestamp.toDate();
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

// --- Keyboard Shortcuts Handler ---
function handleKeyboardShortcuts(e) {
    // Escape key: Close sidebar or modal
    if (e.key === 'Escape') {
        if (!dom.deleteModal.classList.contains('hidden')) {
            dom.deleteModal.classList.add('hidden');
        } else if (!dom.sidebar.classList.contains('-translate-x-full')) {
            toggleSidebar();
        }
    }
    
    // Enter key: Send message (if in chat and not Shift+Enter)
    if (e.key === 'Enter' && !e.shiftKey && !dom.chatUI.classList.contains('hidden')) {
        if (document.activeElement === dom.messageInput) {
            e.preventDefault();
            dom.messageForm.dispatchEvent(new Event('submit'));
        }
    }
    
    // Ctrl/Cmd + K: Focus message input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (!dom.chatUI.classList.contains('hidden')) {
            dom.messageInput.focus();
        }
    }
}

// --- Typing Indicator Functions ---
let typingDebounceTimer = null;

function handleTypingIndicator() {
    if (!currentRoom || !userName || !currentUserId) return;
    
    // Debounce typing indicator updates (update every 1 second max)
    if (typingDebounceTimer) {
        clearTimeout(typingDebounceTimer);
    }
    
    typingDebounceTimer = setTimeout(() => {
        if (!isTyping) {
            isTyping = true;
            // Update typing status in Firestore
            const typingRef = doc(db, 'chat-rooms', currentRoom, 'typing', currentUserId);
            setDoc(typingRef, {
                name: userName,
                timestamp: serverTimestamp()
            }, { merge: true }).catch(err => {
                console.error('Error setting typing status:', err);
                // Don't show error to user for typing indicator failures
            });
        }
        
        // Clear existing timeout
        if (typingTimeout) {
            clearTimeout(typingTimeout);
        }
        
        // Set timeout to stop typing indicator after 3 seconds of inactivity
        typingTimeout = setTimeout(() => {
            stopTypingIndicator();
        }, 3000);
    }, 1000); // Debounce to 1 second
}

function stopTypingIndicator() {
    if (!currentRoom || !currentUserId) return;
    
    // Clear debounce timer
    if (typingDebounceTimer) {
        clearTimeout(typingDebounceTimer);
        typingDebounceTimer = null;
    }
    
    if (isTyping) {
        isTyping = false;
        const typingRef = doc(db, 'chat-rooms', currentRoom, 'typing', currentUserId);
        deleteDoc(typingRef).catch(err => {
            console.error('Error removing typing status:', err);
            // Don't show error to user for typing indicator failures
        });
    }
    
    if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
    }
}

// --- Auto-resize Input ---
function autoResizeInput() {
    dom.messageInput.style.height = 'auto';
    dom.messageInput.style.height = Math.min(dom.messageInput.scrollHeight, 150) + 'px';
}

// --- Connection Error Handler ---
let connectionErrorTimeout = null;

function showConnectionError() {
    // Remove existing error if any
    let existingError = document.getElementById('connection-error');
    if (existingError) {
        return; // Already showing error
    }
    
    const errorDiv = document.createElement('div');
    errorDiv.id = 'connection-error';
    errorDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-yellow-600 text-white px-4 py-2 rounded-lg shadow-lg z-50 animate-fade-in';
    errorDiv.textContent = 'Connection issue. Retrying...';
    document.body.appendChild(errorDiv);
    
    // Auto-hide after 5 seconds if connection is restored
    connectionErrorTimeout = setTimeout(() => {
        hideConnectionError();
    }, 5000);
}

function hideConnectionError() {
    const errorDiv = document.getElementById('connection-error');
    if (errorDiv) {
        errorDiv.classList.add('animate-fade-out');
        setTimeout(() => errorDiv.remove(), 300);
    }
    if (connectionErrorTimeout) {
        clearTimeout(connectionErrorTimeout);
        connectionErrorTimeout = null;
    }
}