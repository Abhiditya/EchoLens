import { useState, useRef, useEffect, useCallback } from "react";

// ─── Gesture Recognition Logic ───────────────────────────────────────────────
function classifyGesture(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;

  const lm = landmarks;
  // Helper: is finger extended?
  const fingerExtended = (tip, pip) => lm[tip].y < lm[pip].y;

  const index = fingerExtended(8, 6);
  const middle = fingerExtended(12, 10);
  const ring = fingerExtended(16, 14);
  const pinky = fingerExtended(20, 18);
  const thumb = lm[4].y < lm[3].y;

  // OK gesture – tip of index close to tip of thumb
  const dx = lm[4].x - lm[8].x;
  const dy = lm[4].y - lm[8].y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Thumbs Up
  if (thumb && !index && !middle && !ring && !pinky) return "Thumbs Up 👍";

  // Thumbs Down
  if (!thumb && !index && !middle && !ring && !pinky && lm[4].y > lm[3].y && lm[4].y > lm[2].y)
    return "Thumbs Down 👎";

  // Open Palm (all fingers extended)
  if (index && middle && ring && pinky && !thumb) return "Open Palm 🖐️";

  // Fist (no fingers extended)
  if (!index && !middle && !ring && !pinky && !thumb) return "Fist ✊";

  // Peace / V Sign (index + middle extended)
  if (index && middle && !ring && !pinky) return "Peace ✌️";

  // Pointing (index only)
  if (index && !middle && !ring && !pinky && !thumb) return "Pointing ☝️";

  // Rock (index + pinky up)
  if (index && !middle && !ring && pinky && !thumb) return "Rock 🤘";

  // OK gesture (thumb and index close)
  if (dist < 0.07 && middle && ring && pinky) return "OK 👌";

  // Victory (index + middle + ring up)
  if (index && middle && ring && !pinky) return "Victory 🤞";

  // Call Me (thumb and pinky extended - like phone)
  if (!index && !middle && !ring && pinky && thumb) return "Call Me ☎️";

  // Love You (index + middle + thumb up)
  if (index && middle && !ring && !pinky && thumb) return "Love You 🤟";

  // Vulcan Salute (index+middle separated, ring+pinky separated)
  if (index && middle && ring && pinky) {
    // Check if there's a gap between middle and ring
    const gapMR = Math.abs(lm[12].x - lm[16].x) > 0.1;
    if (gapMR) return "Spock 🖖";
  }

  // Three Fingers Up (index + middle + ring)
  if (index && middle && ring && !pinky && !thumb) return "Three Fingers 🤌";

  // Wave (hand open with hand position changing - simplified)
  if (index && middle && ring && pinky && !thumb) return "Wave 👋";

  // Gun/Finger Guns (index + thumb extended like gun)
  if (index && thumb && !middle && !ring && !pinky) return "Gun 🔫";

  // Pinky Promise (pinky extended only)
  if (!index && !middle && !ring && pinky && !thumb) return "Pinky Promise 🤞";

  // Horns (index + pinky extended separately)
  if (index && !middle && !ring && pinky && !thumb) return "Horns 🤘";

  // Salute (hand flat with specific angle)
  if (index && middle && ring && pinky && !thumb) return "Salute 🫡";

  return "Unknown";
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function EchoLens() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handposeModelRef = useRef(null);
  const animRef = useRef(null);
  const stableCountRef = useRef(0);
  const lastGestureRef = useRef("");
  const stableGestureRef = useRef("");
  const REQUIRED_FRAMES = 7;

  const [modelLoaded, setModelLoaded] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [currentGesture, setCurrentGesture] = useState("");
  const [history, setHistory] = useState([]);
  const [speechEnabled, setSpeechEnabled] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const historyEndRef = useRef(null);

  // Load TF + Handpose
  useEffect(() => {
    let tfScript, hpScript;

    const load = async () => {
      setLoadingMsg("Loading TensorFlow.js...");
      await new Promise((resolve, reject) => {
        tfScript = document.createElement("script");
        tfScript.src = "https://cdnjs.cloudflare.com/ajax/libs/tensorflow/4.2.0/tf.min.js";
        tfScript.onload = resolve;
        tfScript.onerror = reject;
        document.head.appendChild(tfScript);
      });

      setLoadingMsg("Loading Handpose model...");
      await new Promise((resolve, reject) => {
        hpScript = document.createElement("script");
        hpScript.src = "https://cdn.jsdelivr.net/npm/@tensorflow-models/handpose@0.0.7/dist/handpose.min.js";
        hpScript.onload = resolve;
        hpScript.onerror = reject;
        document.head.appendChild(hpScript);
      });

      setLoadingMsg("Initializing model...");
      try {
        handposeModelRef.current = await window.handpose.load();
        setModelLoaded(true);
        setLoadingMsg("");
      } catch (e) {
        setError("Failed to load handpose model. Please refresh.");
        setLoadingMsg("");
      }
    };

    load().catch(() => {
      setError("Failed to load scripts. Check your connection.");
      setLoadingMsg("");
    });

    return () => {
      if (tfScript) document.head.removeChild(tfScript);
      if (hpScript) document.head.removeChild(hpScript);
    };
  }, []);

  // Auto-scroll history
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
      runDetection();
    } catch (e) {
      setError("Camera access denied. Please allow camera permissions.");
    }
  };

  const stopCamera = () => {
    cancelAnimationFrame(animRef.current);
    const stream = videoRef.current?.srcObject;
    stream?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setCurrentGesture("");
    const ctx = canvasRef.current?.getContext("2d");
    ctx?.clearRect(0, 0, 640, 480);
  };

  const drawHand = (ctx, landmarks) => {
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [0, 9], [9, 10], [10, 11], [11, 12],
      [0, 13], [13, 14], [14, 15], [15, 16],
      [0, 17], [17, 18], [18, 19], [19, 20],
      [5, 9], [9, 13], [13, 17],
    ];
    ctx.strokeStyle = "#00e5ff";
    ctx.lineWidth = 2;
    connections.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(landmarks[a][0], landmarks[a][1]);
      ctx.lineTo(landmarks[b][0], landmarks[b][1]);
      ctx.stroke();
    });
    landmarks.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = "#39ff14";
      ctx.fill();
    });
  };

  const speakText = useCallback((text) => {
    if (!speechEnabled) return;
    const utter = new SpeechSynthesisUtterance(text.replace(/[^\w\s]/gi, ""));
    utter.rate = 1;
    utter.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, [speechEnabled]);

  const runDetection = useCallback(async () => {
    const detect = async () => {
      if (!videoRef.current || !canvasRef.current || !handposeModelRef.current) {
        animRef.current = requestAnimationFrame(detect);
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      try {
        const predictions = await handposeModelRef.current.estimateHands(video);
        if (predictions.length > 0) {
          const hand = predictions[0];
          drawHand(ctx, hand.landmarks);

          // Convert to normalized form for classifier
          const lm = hand.landmarks.map(([x, y, z]) => ({
            x: x / canvas.width,
            y: y / canvas.height,
            z,
          }));

          const gesture = classifyGesture(lm);

          if (gesture === lastGestureRef.current) {
            stableCountRef.current++;
          } else {
            stableCountRef.current = 0;
            lastGestureRef.current = gesture;
          }

          if (stableCountRef.current >= REQUIRED_FRAMES && gesture !== stableGestureRef.current) {
            stableGestureRef.current = gesture;
            if (gesture && gesture !== "Unknown") {
              setCurrentGesture(gesture);
              setHistory(h => [...h.slice(-49), { text: gesture, time: new Date().toLocaleTimeString() }]);
              speakText(gesture);
            }
          }

          if (stableCountRef.current < REQUIRED_FRAMES) {
            setCurrentGesture(gesture || "");
          }
        } else {
          setCurrentGesture("");
          stableCountRef.current = 0;
          lastGestureRef.current = "";
          stableGestureRef.current = "";
        }
      } catch { }

      animRef.current = requestAnimationFrame(detect);
    };
    animRef.current = requestAnimationFrame(detect);
  }, [speakText]);

  const clearHistory = () => {
    setHistory([]);
    setCurrentGesture("");
    stableGestureRef.current = "";
  };

  const bg = darkMode ? "#0a0e17" : "#f0f4f8";
  const surface = darkMode ? "#111827" : "#ffffff";
  const surface2 = darkMode ? "#1a2235" : "#f8fafc";
  const border = darkMode ? "#1e3a5f" : "#d1e0f0";
  const text = darkMode ? "#e2eaf8" : "#1a2035";
  const muted = darkMode ? "#64748b" : "#8899aa";
  const accent = "#00c8ff";
  const accent2 = "#39ff14";

  return (
    <div style={{
      minHeight: "100vh", background: bg, color: text,
      fontFamily: "'Rajdhani', 'Exo 2', sans-serif",
      transition: "all 0.3s ease",
    }}>
      {/* Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e3a5f; border-radius: 4px; }
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes glow {
          0%,100% { text-shadow: 0 0 8px #00c8ff, 0 0 20px #00c8ff44; }
          50% { text-shadow: 0 0 16px #00c8ff, 0 0 40px #00c8ff88, 0 0 60px #00c8ff44; }
        }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px);} to{opacity:1;transform:translateY(0);} }
        .gesture-badge { animation: fadeIn 0.3s ease; }
        .glow-text { animation: glow 3s ease-in-out infinite; }
      `}</style>

      {/* Header */}
      <header style={{
        padding: "16px 32px",
        background: darkMode ? "rgba(10,14,23,0.95)" : "rgba(240,244,248,0.95)",
        borderBottom: `1px solid ${border}`,
        backdropFilter: "blur(12px)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "linear-gradient(135deg, #00c8ff, #0066ff)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18,
          }}>👁️</div>
          <div>
            <h1 className="glow-text" style={{
              fontSize: 24, fontWeight: 700, letterSpacing: 3,
              color: accent, fontFamily: "'Share Tech Mono', monospace",
            }}>ECHO LENS</h1>
            <p style={{ fontSize: 10, color: muted, letterSpacing: 2, textTransform: "uppercase" }}>
              Real-Time Sign Language Interpreter
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={() => setSpeechEnabled(s => !s)} style={{
            padding: "8px 16px", borderRadius: 6, border: `1px solid ${speechEnabled ? accent : border}`,
            background: speechEnabled ? `${accent}22` : "transparent",
            color: speechEnabled ? accent : muted, cursor: "pointer",
            fontSize: 13, fontWeight: 600, letterSpacing: 1,
            transition: "all 0.2s",
          }}>
            {speechEnabled ? "🔊 VOICE ON" : "🔇 VOICE OFF"}
          </button>
          <button onClick={() => setDarkMode(d => !d)} style={{
            padding: "8px 16px", borderRadius: 6, border: `1px solid ${border}`,
            background: "transparent", color: muted, cursor: "pointer",
            fontSize: 13, letterSpacing: 1,
          }}>
            {darkMode ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {/* Loading / Error banner */}
      {(loadingMsg || error) && (
        <div style={{
          background: error ? "#ff003322" : `${accent}11`,
          border: `1px solid ${error ? "#ff0033" : accent}`,
          color: error ? "#ff6688" : accent,
          padding: "12px 32px", fontSize: 13, letterSpacing: 1,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {loadingMsg && <span style={{ animation: "pulse 1s infinite" }}>⚡</span>}
          {error ? `⚠️ ${error}` : loadingMsg}
        </div>
      )}

      {/* Main Layout */}
      <main style={{
        maxWidth: 1200, margin: "0 auto", padding: "32px 24px",
        display: "grid", gridTemplateColumns: "1fr 400px", gap: 24,
      }}>

        {/* Camera Feed */}
        <div>
          <div style={{
            background: surface, borderRadius: 12,
            border: `1px solid ${border}`, overflow: "hidden",
            position: "relative",
          }}>
            {/* Camera header */}
            <div style={{
              padding: "12px 20px",
              borderBottom: `1px solid ${border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 12, letterSpacing: 2, color: muted, textTransform: "uppercase" }}>
                📷 Camera Feed
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: cameraActive ? accent2 : "#ff4444",
                  animation: cameraActive ? "pulse 1.5s infinite" : "none",
                }}></div>
                <span style={{ fontSize: 11, color: cameraActive ? accent2 : "#ff4444", letterSpacing: 1 }}>
                  {cameraActive ? "LIVE" : "OFFLINE"}
                </span>
              </div>
            </div>

            {/* Video + Canvas overlay */}
            <div style={{ position: "relative", background: "#000", aspectRatio: "4/3" }}>
              <video ref={videoRef} style={{
                width: "100%", height: "100%", objectFit: "cover",
                transform: "scaleX(-1)", display: "block",
              }} playsInline muted />
              <canvas ref={canvasRef} style={{
                position: "absolute", top: 0, left: 0,
                width: "100%", height: "100%",
                transform: "scaleX(-1)", pointerEvents: "none",
              }} />

              {/* Gesture overlay */}
              {currentGesture && (
                <div className="gesture-badge" style={{
                  position: "absolute", bottom: 16, left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(0,0,0,0.8)",
                  border: `1px solid ${accent}`,
                  borderRadius: 8, padding: "10px 24px",
                  fontSize: 18, fontWeight: 700,
                  color: accent, letterSpacing: 2,
                  backdropFilter: "blur(8px)",
                }}>
                  {currentGesture}
                </div>
              )}

              {!cameraActive && (
                <div style={{
                  position: "absolute", inset: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexDirection: "column", gap: 12,
                  background: "rgba(0,0,0,0.7)",
                }}>
                  <div style={{ fontSize: 48, opacity: 0.3 }}>🎥</div>
                  <p style={{ color: muted, fontSize: 13, letterSpacing: 2 }}>CAMERA INACTIVE</p>
                </div>
              )}
            </div>

            {/* Controls */}
            <div style={{ padding: "16px 20px", display: "flex", gap: 12 }}>
              {!cameraActive ? (
                <button
                  onClick={startCamera}
                  disabled={!modelLoaded}
                  style={{
                    flex: 1, padding: "12px", borderRadius: 8,
                    background: modelLoaded ? `linear-gradient(135deg, #00c8ff, #0066ff)` : "#333",
                    border: "none", color: "#fff", cursor: modelLoaded ? "pointer" : "not-allowed",
                    fontSize: 14, fontWeight: 700, letterSpacing: 2,
                    transition: "all 0.2s",
                  }}
                >
                  {modelLoaded ? "▶ START DETECTION" : "⏳ LOADING MODEL..."}
                </button>
              ) : (
                <button onClick={stopCamera} style={{
                  flex: 1, padding: "12px", borderRadius: 8,
                  background: "#ff003322", border: "1px solid #ff4444",
                  color: "#ff6688", cursor: "pointer",
                  fontSize: 14, fontWeight: 700, letterSpacing: 2,
                }}>
                  ⏹ STOP
                </button>
              )}
            </div>
          </div>

          {/* Gesture Guide */}
          <div style={{
            marginTop: 20, background: surface, borderRadius: 12,
            border: `1px solid ${border}`, padding: 20,
          }}>
            <p style={{ fontSize: 11, color: muted, letterSpacing: 2, marginBottom: 14, textTransform: "uppercase" }}>
              📖 Supported Gestures
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {[
                "Thumbs Up 👍", "Thumbs Down 👎", "Open Palm 🖐️",
                "Fist ✊", "Peace ✌️", "Pointing ☝️",
                "Rock 🤘", "OK 👌", "Victory 🤞",
                "Call Me ☎️", "Love You 🤟", "Spock 🖖",
                "Three Fingers 🤌", "Wave 👋", "Gun 🔫",
                "Pinky Promise 🤞", "Horns 🤘", "Salute 🫡",
              ].map(g => (
                <div key={g} style={{
                  padding: "8px 10px", borderRadius: 6,
                  background: surface2, border: `1px solid ${border}`,
                  fontSize: 12, color: muted, textAlign: "center",
                  transition: "all 0.2s",
                }}>
                  {g}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Output Panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Current Detection */}
          <div style={{
            background: surface, borderRadius: 12,
            border: `1px solid ${border}`,
            padding: 24, textAlign: "center",
          }}>
            <p style={{ fontSize: 11, color: muted, letterSpacing: 2, marginBottom: 16, textTransform: "uppercase" }}>
              ⚡ Live Detection
            </p>
            <div style={{
              minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center",
              background: surface2, borderRadius: 10, border: `1px solid ${border}`,
              padding: 16,
            }}>
              {currentGesture ? (
                <span className="gesture-badge" style={{
                  fontSize: 28, fontWeight: 700, color: accent,
                  fontFamily: "'Share Tech Mono', monospace",
                  letterSpacing: 1,
                }}>
                  {currentGesture}
                </span>
              ) : (
                <span style={{ color: muted, fontSize: 13, letterSpacing: 2 }}>
                  {cameraActive ? "Waiting for gesture..." : "Start camera to begin"}
                </span>
              )}
            </div>
          </div>

          {/* Output History */}
          <div style={{
            background: surface, borderRadius: 12,
            border: `1px solid ${border}`,
            flex: 1, display: "flex", flexDirection: "column",
          }}>
            <div style={{
              padding: "12px 20px", borderBottom: `1px solid ${border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 11, color: muted, letterSpacing: 2, textTransform: "uppercase" }}>
                📋 Output History ({history.length})
              </span>
              <button onClick={clearHistory} style={{
                background: "transparent", border: `1px solid ${border}`,
                color: muted, cursor: "pointer", borderRadius: 4,
                padding: "4px 10px", fontSize: 11, letterSpacing: 1,
              }}>
                🗑 CLEAR
              </button>
            </div>

            <div style={{
              flex: 1, overflowY: "auto", padding: 16,
              maxHeight: 320, display: "flex", flexDirection: "column", gap: 6,
            }}>
              {history.length === 0 ? (
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  height: "100%", color: muted, fontSize: 12, letterSpacing: 2,
                  flexDirection: "column", gap: 8, padding: 32,
                }}>
                  <span style={{ fontSize: 32, opacity: 0.3 }}>🤟</span>
                  <span>Make a sign in front of the camera...</span>
                </div>
              ) : (
                history.map((item, i) => (
                  <div key={i} className="gesture-badge" style={{
                    padding: "8px 14px", borderRadius: 6,
                    background: surface2, border: `1px solid ${border}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    fontSize: 14, fontWeight: 600,
                  }}>
                    <span style={{ color: text }}>{item.text}</span>
                    <span style={{ color: muted, fontSize: 10, fontFamily: "'Share Tech Mono', monospace" }}>
                      {item.time}
                    </span>
                  </div>
                ))
              )}
              <div ref={historyEndRef} />
            </div>
          </div>

          {/* Stats */}
          <div style={{
            background: surface, borderRadius: 12,
            border: `1px solid ${border}`, padding: 20,
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
          }}>
            {[
              { label: "Gestures Detected", value: history.length, icon: "✋" },
              { label: "Model Status", value: modelLoaded ? "READY" : "LOADING", icon: "🧠" },
              { label: "Voice Output", value: speechEnabled ? "ON" : "OFF", icon: "🔊" },
              { label: "Camera", value: cameraActive ? "ACTIVE" : "IDLE", icon: "📷" },
            ].map(s => (
              <div key={s.label} style={{
                background: surface2, borderRadius: 8,
                border: `1px solid ${border}`, padding: "12px 14px",
              }}>
                <p style={{ fontSize: 10, color: muted, letterSpacing: 1, marginBottom: 4, textTransform: "uppercase" }}>
                  {s.icon} {s.label}
                </p>
                <p style={{
                  fontSize: 16, fontWeight: 700,
                  color: s.value === "READY" || s.value === "ACTIVE" || s.value === "ON" ? accent2
                    : s.value === "LOADING" ? "#ffaa00" : text,
                  fontFamily: "'Share Tech Mono', monospace",
                }}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer style={{
        borderTop: `1px solid ${border}`, padding: "12px 32px",
        textAlign: "center", color: muted, fontSize: 11, letterSpacing: 2,
      }}>
        ECHOLENS — BRIDGING COMMUNICATION GAPS WITH AI · G.L. BAJAJ INSTITUTE OF TECHNOLOGY & MANAGEMENT
      </footer>
    </div>
  );
}
