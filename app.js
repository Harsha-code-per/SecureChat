/*
* SecureChat App Logic
* This file handles all the client-side logic for the SecureChat app.
* It works with the Firebase SDK (imported in index.html) and manipulates the DOM.
*/

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
let isNavigating = false; // Prevents hashchange loop
let usersInRoom = new Map(); // Local cache of users

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

    // Check the URL hash to see if we're joining a room
    handleHashChange();
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
    dom.backToRoomsBtn.addEventListener('click', () => window.location.hash = '');
    dom.sidebarToggleBtn.addEventListener('click', toggleSidebar);
    dom.sidebarOverlay.addEventListener('click', toggleSidebar);
    dom.leaveChatHeaderBtn.addEventListener('click', handleLeaveRoom);
    dom.deleteChatBtn.addEventListener('click', () => dom.deleteModal.classList.remove('hidden'));
    dom.cancelDeleteBtn.addEventListener('click', () => dom.deleteModal.classList.add('hidden'));
    dom.confirmDeleteBtn.addEventListener('click', handleDeleteChat);

    // Title notifications
    window.addEventListener('blur', () => isWindowActive = false);
    window.addEventListener('focus', () => {
        isWindowActive = true;
        unreadMessages = 0;
        document.title = "SecureChat";
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
    dom.sidebar.classList.toggle('-translate-x-full');
    dom.sidebarOverlay.classList.toggle('hidden');
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
        // No room in hash, go to room selection
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
                // Password matches, navigate to name screen
                currentRoom = roomName; // <-- THE FIX IS HERE
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
            // Room created, navigate to name screen
            currentRoom = roomName; // <-- THE FIX IS HERE
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
            // Password is correct! Show name selection.
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

        if (existingUserDoc) {
            // This is us re-joining. Just update the timestamp.
            // This requires the 'update' rule in Firebase!
            await updateDoc(userDocRef, {
                joined: serverTimestamp() // Update joined time
            });
            // We don't post a "joined" message again.
        } else {
            // This is a new user or a new name.
            await setDoc(userDocRef, {
                name: userName,
                joined: serverTimestamp()
            });

            // Post "User has joined" message
            await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
                type: 'event',
                text: `${userName} has joined the room.`,
                timestamp: serverTimestamp(),
                senderId: 'system'
            });
        }

        // Successfully joined
        showUI('chat');
        dom.messageInput.focus();
        listenForMessages();
        listenForUsers();

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
    if (!currentRoom || !userName || !currentUserId) return;

    // Hide sidebar if open
    dom.sidebar.classList.add('-translate-x-full');
    dom.sidebarOverlay.classList.add('hidden');

    try {
        // 1. Post "User has left" message
        await addDoc(collection(db, 'chat-rooms', currentRoom, 'messages'), {
            type: 'event',
            text: `${userName} has left the room.`,
            timestamp: serverTimestamp(),
            senderId: 'system'
        });

        // 2. Delete user from the 'users' list
        const userDocRef = doc(db, 'chat-rooms', currentRoom, 'users', currentUserId);
        await deleteDoc(userDocRef);

        // 3. Go back to room selection
        window.location.hash = ''; // This triggers handleHashChange

    } catch (error) {
        console.error("Error leaving room:", error);
        // Still force-navigate back
        window.location.hash = '';
    }
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
        let messages = [];
        let modifiedMessages = [];

        snapshot.docChanges().forEach(change => {
            const msgData = { id: change.doc.id, ...change.doc.data() };
            if (change.type === 'added') {
                messages.push(msgData);
                // Handle title notification
                if (msgData.senderId !== currentUserId && !isWindowActive) {
                    unreadMessages++;
                    document.title = `(${unreadMessages}) SecureChat`;
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
                    msgElement.remove();
                }
            }
        });

        // Sort all new messages by timestamp
        messages.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
        
        renderMessages(messages, 'added');
        
    }, (error) => {
        console.error("Error listening for messages:", error);
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

    }, (error) => {
        console.error("Error listening for users:", error);
    });
}

/**
 * Renders messages to the chat window.
 * @param {Array} messages - An array of message objects to render.
 * @param {string} type - 'added' or 'all'. 'added' appends, 'all' overwrites.
 */
function renderMessages(messages, type) {
    if (type === 'all') {
        dom.messageList.innerHTML = '';
    }
    
    const shouldScroll = dom.messageList.scrollTop + dom.messageList.clientHeight >= dom.messageList.scrollHeight - 30;

    messages.forEach(msg => {
        const isSelf = msg.senderId === currentUserId;
        const isSystem = msg.senderId === 'system';

        const messageWrapper = document.createElement('div');
        messageWrapper.setAttribute('data-id', msg.id);

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
                'shadow',
                isSelf ? 'bg-blue-600' : 'bg-gray-600'
            );
            
            const senderName = document.createElement('div');
            senderName.classList.add('font-bold', 'text-sm', 'mb-1');
            senderName.textContent = msg.name || 'Anonymous';
            
            const messageText = document.createElement('div');
            messageText.classList.add('text-white', 'break-words', 'whitespace-pre-wrap');
            messageText.textContent = msg.text || ''; // Use textContent for security

            const timestamp = document.createElement('div');
            timestamp.classList.add('text-xs', 'text-gray-300', 'mt-1', 'text-right', 'chat-timestamp');
            timestamp.textContent = formatTimestamp(msg.timestamp);

            messageBubble.appendChild(senderName);
            messageBubble.appendChild(messageText);
            messageBubble.appendChild(timestamp);
            messageWrapper.appendChild(messageBubble);
        }
        dom.messageList.appendChild(messageWrapper);
    });

    // Auto-scroll to bottom only if user was already at the bottom
    if (shouldScroll) {
        dom.messageList.scrollTop = dom.messageList.scrollHeight;
    }
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
        dom.messageInput.value = ''; // Clear input immediately
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

// --- Title Notification Globals ---
let isWindowActive = true;
let unreadMessages = 0;