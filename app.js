// ---- Config ----
const STATUS_OPTIONS = [
  { id: "available", label: "Available", color: "#22c55e" },
  { id: "no_msg", label: "No msg", color: "#ef4444" },
];

const LS_KEYS = { pin: "msgme_pin", identity: "msgme_identity", sound: "msgme_sound_enabled" };

// ---- Helpers ----
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function otherOf(id) { return id === "A" ? "B" : "A"; }

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function timeAgo(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// ---- State ----
let db = null;
let appPathHash = null;
let myIdentity = null;
let statusListenerRef = null;
let messageListenerRef = null;
let seenListenerRef = null;
let typingListenerRef = null;
let connListenerRef = null;
let partnerLastLoginListenerRef = null;
let partnerLastLoginTs = null;
let partnerLastReadTs = null;
let partnerUnreadListenerRef = null;
let lastMineMeta = null;
let replyTarget = null;
let lastTypingWriteAt = 0;
let typingClearTimer = null;
let typingHideTimer = null;
let appLabelText = "U2U";
let unreadCount = 0;
let soundEnabled = localStorage.getItem(LS_KEYS.sound) === "1";
let audioCtx = null;
const TYPING_STALE_MS = 5000;

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount = 0;
    document.title = appLabelText;
  }
});

const $ = (sel) => document.querySelector(sel);

// ---- Notification sound (foreground only, off by default) ----
function updateSoundIcon() {
  $("#sound-icon-on").classList.toggle("hidden", !soundEnabled);
  $("#sound-icon-off").classList.toggle("hidden", soundEnabled);
  $("#sound-toggle").title = soundEnabled ? "Sound on" : "Sound off";
}

function playNotificationSound() {
  if (!soundEnabled) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.35);
}

$("#sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem(LS_KEYS.sound, soundEnabled ? "1" : "0");
  updateSoundIcon();
  if (soundEnabled) playNotificationSound(); // also unlocks audio on iOS via this tap
});

updateSoundIcon();

// ---- Screens ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

// ---- PIN gate ----
$("#pin-submit").addEventListener("click", handlePinSubmit);
$("#pin-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handlePinSubmit(); });

async function handlePinSubmit() {
  const pin = $("#pin-input").value.trim();
  if (!pin) { $("#pin-error").textContent = "Enter a PIN."; return; }
  await activatePin(pin, true);
}

async function activatePin(pin, persist) {
  appPathHash = await sha256Hex("msgme_v1_" + pin);
  db = firebase.database();
  if (persist) localStorage.setItem(LS_KEYS.pin, pin);
  proceedAfterPin();
}

function proceedAfterPin() {
  const savedIdentity = localStorage.getItem(LS_KEYS.identity);
  if (savedIdentity === "A" || savedIdentity === "B") {
    startApp(savedIdentity);
  } else {
    showScreen("#identity-screen");
  }
}

// ---- Identity ----
document.querySelectorAll(".identity-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.id;
    localStorage.setItem(LS_KEYS.identity, id);
    startApp(id);
  });
});

$("#logout-btn").addEventListener("click", () => {
  setTypingFlag(false);
  detachListeners();
  localStorage.removeItem(LS_KEYS.identity);
  localStorage.removeItem(LS_KEYS.pin);
  myIdentity = null;
  db = null;
  appPathHash = null;
  $("#pin-input").value = "";
  $("#pin-error").textContent = "";
  unreadCount = 0;
  appLabelText = "U2U";
  document.title = appLabelText;
  partnerLastLoginTs = null;
  partnerLastReadTs = null;
  $("#partner-last-login").textContent = "last login: never";
  $("#partner-last-read").textContent = "last read: never";
  $("#partner-unread").textContent = "unread: 0";
  showScreen("#pin-screen");
});

// ---- Main app ----
function resetChatThread() {
  $("#chat-thread").innerHTML = '<p class="chat-empty" id="chat-empty">No messages yet this session.</p>';
  lastMineMeta = null;
  cancelReply();
}

function shortId(id) { return id === "A" ? "U1" : "U2"; }

function startApp(identity) {
  myIdentity = identity;
  $("#me-tag").textContent = shortId(identity);
  const label = shortId(identity) + "→" + shortId(otherOf(identity));
  appLabelText = label;
  unreadCount = 0;
  $("#app-label").textContent = label;
  document.title = label;
  resetChatThread();
  buildStatusOptions();
  attachListeners();
  db.ref(`apps/${appPathHash}/lastLogin/${myIdentity}`).set(firebase.database.ServerValue.TIMESTAMP);
  showScreen("#main-screen");
}

function buildStatusOptions() {
  const container = $("#status-options");
  container.innerHTML = "";
  STATUS_OPTIONS.forEach(opt => {
    const btn = document.createElement("button");
    btn.className = "status-option";
    btn.style.setProperty("--opt-color", opt.color);
    btn.textContent = opt.label;
    btn.dataset.id = opt.id;
    btn.addEventListener("click", () => setMyStatus(opt.id));
    container.appendChild(btn);
  });
}

function markSelectedStatus(statusId) {
  document.querySelectorAll(".status-option").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.id === statusId);
  });
}

function setMyStatus(statusId) {
  db.ref(`apps/${appPathHash}/status/${myIdentity}`).set({
    id: statusId,
    ts: firebase.database.ServerValue.TIMESTAMP,
  });
  markSelectedStatus(statusId);
}

function attachListeners() {
  const mine = otherOf(myIdentity);

  // my own status, to keep the selected tile highlighted across devices/reloads
  db.ref(`apps/${appPathHash}/status/${myIdentity}`).once("value", snap => {
    const v = snap.val();
    if (v && v.id) markSelectedStatus(v.id);
  });

  // partner status, live
  statusListenerRef = db.ref(`apps/${appPathHash}/status/${mine}`);
  statusListenerRef.on("value", snap => {
    const v = snap.val();
    renderPartnerStatus(v);
  });

  // incoming messages, live (queued, oldest first — replays unread backlog on login)
  messageListenerRef = db.ref(`apps/${appPathHash}/messages/${myIdentity}`);
  messageListenerRef.on("child_added", snap => {
    const v = snap.val();
    if (v && (v.text || v.imageData)) showIncomingMessage(v, snap.key);
  });

  // partner has seen my last message, live (also drives the persistent "last read" line)
  seenListenerRef = db.ref(`apps/${appPathHash}/seen/${mine}`);
  seenListenerRef.on("value", snap => {
    const v = snap.val();
    if (v && v.ts) {
      partnerLastReadTs = v.ts;
      renderPartnerLastRead();
      if (lastMineMeta) {
        const seenClock = new Date(v.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const sentText = lastMineMeta.dataset.sentText || lastMineMeta.textContent;
        lastMineMeta.textContent = sentText + " · Seen " + seenClock;
      }
    }
  });

  // partner's last login time, live
  partnerLastLoginListenerRef = db.ref(`apps/${appPathHash}/lastLogin/${mine}`);
  partnerLastLoginListenerRef.on("value", snap => {
    partnerLastLoginTs = snap.val();
    renderPartnerLastLogin();
  });

  // how many of my sent messages partner still hasn't read (still queued in their inbox), live
  partnerUnreadListenerRef = db.ref(`apps/${appPathHash}/messages/${mine}`);
  partnerUnreadListenerRef.on("value", snap => {
    renderPartnerUnread(snap.numChildren());
  });

  // partner is typing, live
  typingListenerRef = db.ref(`apps/${appPathHash}/typing/${mine}`);
  typingListenerRef.on("value", snap => {
    showTypingIndicator(snap.val());
  });

  // connection state, live
  connListenerRef = firebase.database().ref(".info/connected");
  connListenerRef.on("value", snap => {
    setConnDot(snap.val() === true);
  });
}

function setConnDot(isOnline) {
  const dot = $("#conn-dot");
  dot.classList.toggle("online", isOnline);
  dot.classList.toggle("offline", !isOnline);
  dot.title = isOnline ? "Live" : "Reconnecting…";
}

function detachListeners() {
  if (statusListenerRef) statusListenerRef.off();
  if (messageListenerRef) messageListenerRef.off();
  if (seenListenerRef) seenListenerRef.off();
  if (partnerLastLoginListenerRef) partnerLastLoginListenerRef.off();
  if (partnerUnreadListenerRef) partnerUnreadListenerRef.off();
  if (typingListenerRef) typingListenerRef.off();
  if (connListenerRef) connListenerRef.off();
  clearTimeout(typingClearTimer);
  clearTimeout(typingHideTimer);
  $("#typing-indicator").classList.add("hidden");
  setConnDot(false);
}

// ---- Typing indicator ----
function setTypingFlag(isTyping) {
  if (!db) return;
  const ref = db.ref(`apps/${appPathHash}/typing/${myIdentity}`);
  if (isTyping) {
    const now = Date.now();
    if (now - lastTypingWriteAt < 2000) return;
    lastTypingWriteAt = now;
    ref.set(firebase.database.ServerValue.TIMESTAMP);
    ref.onDisconnect().remove();
  } else {
    lastTypingWriteAt = 0;
    ref.remove();
  }
}

function showTypingIndicator(ts) {
  const el = $("#typing-indicator");
  clearTimeout(typingHideTimer);
  const age = ts ? Date.now() - ts : Infinity;
  if (ts && age < TYPING_STALE_MS) {
    el.classList.remove("hidden");
    typingHideTimer = setTimeout(() => el.classList.add("hidden"), TYPING_STALE_MS - age);
  } else {
    el.classList.add("hidden");
  }
}

$("#msg-input").addEventListener("input", () => {
  clearTimeout(typingClearTimer);
  if ($("#msg-input").value.trim()) {
    setTypingFlag(true);
    typingClearTimer = setTimeout(() => setTypingFlag(false), 3000);
  } else {
    setTypingFlag(false);
  }
});

$("#msg-input").addEventListener("blur", () => {
  clearTimeout(typingClearTimer);
  setTypingFlag(false);
});

function renderPartnerStatus(v) {
  const badge = $("#partner-badge");
  const updated = $("#partner-updated");
  if (!v || !v.id) {
    badge.textContent = "—";
    badge.style.background = "";
    updated.textContent = "not set yet";
    return;
  }
  const opt = STATUS_OPTIONS.find(o => o.id === v.id);
  badge.textContent = opt ? opt.label : v.id;
  badge.style.background = opt ? opt.color : "";
  updated.textContent = "updated " + timeAgo(v.ts);
}

function renderPartnerLastLogin() {
  $("#partner-last-login").textContent = "last login: " + timeAgo(partnerLastLoginTs);
}

function renderPartnerLastRead() {
  $("#partner-last-read").textContent = "last read: " + timeAgo(partnerLastReadTs);
}

function renderPartnerUnread(count) {
  $("#partner-unread").textContent = count > 0 ? `unread: ${count}` : "unread: 0";
}

// keep "updated X ago" / "last login" / "last read" fresh
setInterval(() => {
  const badge = $("#partner-badge");
  if (db && myIdentity && badge && badge.textContent !== "—") {
    db.ref(`apps/${appPathHash}/status/${otherOf(myIdentity)}`).once("value", s => renderPartnerStatus(s.val()));
  }
  if (db && myIdentity) {
    renderPartnerLastLogin();
    renderPartnerLastRead();
  }
}, 30000);

// ---- Chat thread (session-only, nothing persisted after it's read) ----
function appendChatBubble(text, who, ts, replyTo, imageData, msgKey) {
  const empty = $("#chat-empty");
  if (empty) empty.remove();
  const thread = $("#chat-thread");
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + (who === "me" ? "mine" : "theirs");

  if (replyTo) {
    const quote = document.createElement("div");
    quote.className = "quote-block";
    quote.textContent = "↩ " + replyTo;
    bubble.appendChild(quote);
  }

  if (imageData) {
    const img = document.createElement("img");
    img.className = "chat-image";
    img.src = imageData;
    img.alt = "Photo";
    bubble.appendChild(img);

    const dl = document.createElement("a");
    dl.className = "text-btn image-download-btn";
    dl.textContent = "Download";
    dl.href = imageData;
    dl.download = `photo-${ts || Date.now()}.jpg`;
    dl.addEventListener("click", (e) => e.stopPropagation());
    bubble.appendChild(dl);
  } else {
    const p = document.createElement("p");
    p.className = "chat-text";
    p.textContent = text;
    bubble.appendChild(p);
  }

  const meta = document.createElement("span");
  meta.className = "chat-meta";
  const clock = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = who === "me" ? (clock + " · Sent") : (clock + " · sent " + timeAgo(ts));
  if (who === "me") meta.dataset.sentText = meta.textContent;
  bubble.appendChild(meta);

  if (who === "me" && msgKey) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "text-btn bubble-delete-btn";
    del.textContent = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSentMessage(msgKey, bubble);
    });
    bubble.appendChild(del);
  }

  if (text) bubble.addEventListener("click", () => setReplyTarget(text));
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return { bubble, meta };
}

// removes the message from the recipient's unread queue if they haven't opened it yet;
// harmless no-op if they've already seen it (it's already gone from the database either way)
function deleteSentMessage(key, bubbleEl) {
  db.ref(`apps/${appPathHash}/messages/${otherOf(myIdentity)}/${key}`).remove();
  bubbleEl.remove();
}

// ---- Reply-to ----
function setReplyTarget(text) {
  replyTarget = text;
  $("#reply-preview-text").textContent = truncate(text, 80);
  $("#reply-preview").classList.remove("hidden");
  $("#msg-input").focus();
}

function cancelReply() {
  replyTarget = null;
  $("#reply-preview").classList.add("hidden");
  $("#reply-preview-text").textContent = "";
}

$("#reply-cancel").addEventListener("click", cancelReply);

// ---- Clearing chat ----
$("#clear-chat").addEventListener("click", resetChatThread);

// ---- Sending messages ----
const MAX_QUEUED_MESSAGES = 10;

$("#msg-send").addEventListener("click", () => {
  const text = $("#msg-input").value.trim();
  if (!text) return;
  clearTimeout(typingClearTimer);
  setTypingFlag(false);
  const to = otherOf(myIdentity);
  const payload = {
    text,
    from: myIdentity,
    ts: firebase.database.ServerValue.TIMESTAMP,
  };
  if (replyTarget) payload.replyTo = truncate(replyTarget, 80);
  const msgsRef = db.ref(`apps/${appPathHash}/messages/${to}`);
  const newRef = msgsRef.push(payload);
  trimOldMessages(msgsRef);
  const { meta } = appendChatBubble(text, "me", Date.now(), payload.replyTo, null, newRef.key);
  lastMineMeta = meta;
  $("#msg-input").value = "";
  cancelReply();
});

// keep only the most recent MAX_QUEUED_MESSAGES unread messages per recipient
function trimOldMessages(msgsRef) {
  msgsRef.once("value", snap => {
    const keys = [];
    snap.forEach(child => { keys.push(child.key); });
    if (keys.length <= MAX_QUEUED_MESSAGES) return;
    const updates = {};
    keys.slice(0, keys.length - MAX_QUEUED_MESSAGES).forEach(k => { updates[k] = null; });
    msgsRef.update(updates);
  });
}

// ---- Sending photos ----
const IMAGE_MAX_DIMENSION = 900;
const IMAGE_QUALITY = 0.6;

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
          if (width > height) {
            height = Math.round(height * IMAGE_MAX_DIMENSION / width);
            width = IMAGE_MAX_DIMENSION;
          } else {
            width = Math.round(width * IMAGE_MAX_DIMENSION / height);
            height = IMAGE_MAX_DIMENSION;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

$("#image-pick-btn").addEventListener("click", () => $("#image-input").click());

$("#image-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !file.type.startsWith("image/")) return;
  let dataUrl;
  try {
    dataUrl = await compressImageFile(file);
  } catch (err) {
    console.error("Failed to process image", err);
    return;
  }
  const to = otherOf(myIdentity);
  const payload = {
    type: "image",
    imageData: dataUrl,
    from: myIdentity,
    ts: firebase.database.ServerValue.TIMESTAMP,
  };
  const msgsRef = db.ref(`apps/${appPathHash}/messages/${to}`);
  const newRef = msgsRef.push(payload);
  trimOldMessages(msgsRef);
  const { meta } = appendChatBubble(null, "me", Date.now(), null, dataUrl, newRef.key);
  lastMineMeta = meta;
});

// ---- Receiving messages ----
function flashChatPanel() {
  const panel = $(".chat-panel");
  panel.classList.remove("flash");
  void panel.offsetWidth; // restart animation if already mid-flash
  panel.classList.add("flash");
}

function bumpUnreadTitle() {
  if (!document.hidden) return;
  unreadCount++;
  document.title = `(${unreadCount}) ${appLabelText}`;
}

function showIncomingMessage(v, key) {
  if (v.type === "image") {
    appendChatBubble(null, "them", v.ts, null, v.imageData);
  } else {
    appendChatBubble(v.text, "them", v.ts, v.replyTo);
  }
  flashChatPanel();
  bumpUnreadTitle();
  playNotificationSound();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  // not stored server-side: clear it from the database now that it's been shown
  db.ref(`apps/${appPathHash}/messages/${myIdentity}/${key}`).remove();
  // let the sender know their message has been seen
  db.ref(`apps/${appPathHash}/seen/${myIdentity}`).set({
    ts: firebase.database.ServerValue.TIMESTAMP,
  });
}

// ---- Boot ----
(function boot() {
  const savedPin = localStorage.getItem(LS_KEYS.pin);
  if (savedPin) {
    activatePin(savedPin, false);
  } else {
    showScreen("#pin-screen");
  }
})();
