// ---- Config ----
const STATUS_OPTIONS = [
  { id: "available", label: "Available", color: "#22c55e" },
  { id: "no_msg", label: "Busy - NO MSG", color: "#ef4444" },
  { id: "at_work", label: "At Work", color: "#f59e0b" },
  { id: "at_home", label: "At Home", color: "#a855f7" },
];

const LS_KEYS = { pin: "bs_pin", identity: "bs_identity" };

// ---- Helpers ----
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function otherOf(id) { return id === "A" ? "B" : "A"; }

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

const $ = (sel) => document.querySelector(sel);

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
  appPathHash = await sha256Hex("buddystatus_v1_" + pin);
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

$("#switch-identity").addEventListener("click", () => {
  detachListeners();
  localStorage.removeItem(LS_KEYS.identity);
  showScreen("#identity-screen");
});

$("#logout-btn").addEventListener("click", () => {
  detachListeners();
  localStorage.removeItem(LS_KEYS.identity);
  localStorage.removeItem(LS_KEYS.pin);
  myIdentity = null;
  db = null;
  appPathHash = null;
  $("#pin-input").value = "";
  $("#pin-error").textContent = "";
  showScreen("#pin-screen");
});

// ---- Main app ----
function resetChatThread() {
  $("#chat-thread").innerHTML = '<p class="chat-empty" id="chat-empty">No messages yet this session.</p>';
}

function startApp(identity) {
  myIdentity = identity;
  $("#me-label").textContent = "You: Person " + identity;
  resetChatThread();
  buildStatusOptions();
  attachListeners();
  showScreen("#main-screen");
}

function buildStatusOptions() {
  const container = $("#status-options");
  container.innerHTML = "";
  STATUS_OPTIONS.forEach(opt => {
    const btn = document.createElement("button");
    btn.className = "status-option active";
    btn.style.color = opt.color;
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

  // incoming messages, live
  messageListenerRef = db.ref(`apps/${appPathHash}/messages/${myIdentity}`);
  messageListenerRef.on("value", snap => {
    const v = snap.val();
    if (v && v.text) showIncomingMessage(v);
  });
}

function detachListeners() {
  if (statusListenerRef) statusListenerRef.off();
  if (messageListenerRef) messageListenerRef.off();
}

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

// keep "updated X ago" fresh
setInterval(() => {
  const badge = $("#partner-badge");
  if (db && myIdentity && badge && badge.textContent !== "—") {
    db.ref(`apps/${appPathHash}/status/${otherOf(myIdentity)}`).once("value", s => renderPartnerStatus(s.val()));
  }
}, 30000);

// ---- Chat thread (session-only, nothing persisted after it's read) ----
function appendChatBubble(text, who, ts) {
  const empty = $("#chat-empty");
  if (empty) empty.remove();
  const thread = $("#chat-thread");
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + (who === "me" ? "mine" : "theirs");
  const p = document.createElement("p");
  p.className = "chat-text";
  p.textContent = text;
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  bubble.appendChild(p);
  bubble.appendChild(time);
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

// ---- Sending messages ----
$("#msg-send").addEventListener("click", () => {
  const text = $("#msg-input").value.trim();
  if (!text) return;
  const to = otherOf(myIdentity);
  db.ref(`apps/${appPathHash}/messages/${to}`).set({
    text,
    from: myIdentity,
    ts: firebase.database.ServerValue.TIMESTAMP,
  });
  appendChatBubble(text, "me", Date.now());
  $("#msg-input").value = "";
});

// ---- Receiving messages ----
function showIncomingMessage(v) {
  appendChatBubble(v.text, "them", v.ts);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  // not stored server-side: clear it from the database now that it's been shown
  db.ref(`apps/${appPathHash}/messages/${myIdentity}`).remove();
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
