import { useState, useEffect, useRef, useCallback } from 'react';
import { HornDetector, DetectorSnapshot, DetectionState } from './dsp/detector';
import { GoertzelBin } from './dsp/goertzel';
import { computeTDOA, bandpassFilter, TDOAResult } from './dsp/tdoa';
import './App.css';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 160;
const FRAME_DURATION_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;
const ALERT_PERSIST_MS = 1500;

interface DemoClip {
  id: string;
  name: string;
  videoUrl: string;
  thumbUrl: string;
  description: string;
}

const DEMO_CLIPS: DemoClip[] = [
  {
    id: 'scooty-overtake',
    name: 'Scooty Overtake From Behind',
    videoUrl: '/clips/scooty-overtake.mp4',
    thumbUrl: '/clips/scooty-overtake-thumb.jpg',
    description: 'Bangalore traffic — rapid scooty horn bursts at 3.5kHz (10s)',
  },
  {
    id: 'crowded-road',
    name: 'Crowded Road Crossing',
    videoUrl: '/clips/crowded-road.mp4',
    thumbUrl: '/clips/crowded-road-thumb.jpg',
    description: 'Dense intersection — mixed traffic with horn events (26s)',
  },
  {
    id: 'traffic-light',
    name: 'Dangerous Traffic Light Crossing',
    videoUrl: '/clips/traffic-light.mp4',
    thumbUrl: '/clips/traffic-light-thumb.jpg',
    description: 'Chaotic signal crossing — heavy honking from all directions (49s)',
  },
  {
    id: 'night-nearmiss',
    name: 'Night Time Low Visibility Near Miss',
    videoUrl: '/clips/night-nearmiss.mp4',
    thumbUrl: '/clips/night-nearmiss-thumb.jpg',
    description: 'Night riding — horns critical when visibility is near zero (13s)',
  },
];

interface LogEntry {
  timeMs: number; frame: number; state: DetectionState; prevState: DetectionState;
  scr: number; centroid: number; hiLoRatio: number; band: string | null;
  peakFreq: number; isTransition: boolean;
  direction?: string; tdoaLag?: number; tdoaAngle?: number;
}

function App() {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'video' | 'audio'>('video');
  const [fileName, setFileName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const [snapshot, setSnapshot] = useState<DetectorSnapshot | null>(null);
  const [tdoa, setTdoa] = useState<TDOAResult | null>(null);
  const [waveHistory, setWaveHistory] = useState<{ l: Float32Array; r: Float32Array }[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [detectionCount, setDetectionCount] = useState(0);
  const [timeMs, setTimeMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [battery, setBattery] = useState(100);

  // Alert persistence — stays visible for 3 seconds after last detection
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertFading, setAlertFading] = useState(false);
  const [lastAlertSnap, setLastAlertSnap] = useState<DetectorSnapshot | null>(null);
  const [lastAlertTdoa, setLastAlertTdoa] = useState<TDOAResult | null>(null);
  const alertTimerRef = useRef<number>(0);

  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const corrCanvasRef = useRef<HTMLCanvasElement>(null);
  const detectorRef = useRef<HornDetector>(new HornDetector());
  const leftBufRef = useRef<Float32Array>(new Float32Array(0));
  const rightBufRef = useRef<Float32Array>(new Float32Array(0));
  const animRef = useRef<number>(0);
  const processedUpToRef = useRef<number>(0);
  const lastTdoaRef = useRef<TDOAResult | null>(null);
  const logRef = useRef<LogEntry[]>([]);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setMediaType(file.type.startsWith('video/') ? 'video' : 'audio');
    setMediaUrl(URL.createObjectURL(file));

    const actx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const decoded = await actx.decodeAudioData(await file.arrayBuffer());
    actx.close();

    leftBufRef.current = decoded.getChannelData(0);
    rightBufRef.current = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
    setTotalMs((decoded.length / SAMPLE_RATE) * 1000);

    detectorRef.current.reset();
    processedUpToRef.current = 0;
    lastTdoaRef.current = null;
    logRef.current = [];
    setSnapshot(null); setTdoa(null); setWaveHistory([]); setLog([]);
    setDetectionCount(0); setTimeMs(0); setBattery(100);
    setAlertVisible(false); setAlertFading(false);
    setIsProcessing(true); setIsPlaying(false);
  }, []);

  const loadFromUrl = useCallback(async (clip: DemoClip) => {
    setFileName(clip.name);
    setMediaType('video');
    setMediaUrl(clip.videoUrl);

    const resp = await fetch(clip.videoUrl);
    const arrayBuf = await resp.arrayBuffer();
    const actx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const decoded = await actx.decodeAudioData(arrayBuf);
    actx.close();

    leftBufRef.current = decoded.getChannelData(0);
    rightBufRef.current = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
    setTotalMs((decoded.length / SAMPLE_RATE) * 1000);

    detectorRef.current.reset();
    processedUpToRef.current = 0;
    lastTdoaRef.current = null;
    logRef.current = [];
    setSnapshot(null); setTdoa(null); setWaveHistory([]); setLog([]);
    setDetectionCount(0); setTimeMs(0); setBattery(100);
    setAlertVisible(false); setAlertFading(false);
    setIsProcessing(true); setIsPlaying(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  }, [handleFile]);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);

  const processUpTo = useCallback((targetSample: number) => {
    const left = leftBufRef.current, right = rightBufRef.current;
    let pos = processedUpToRef.current;
    const maxFrames = 50;
    let framesProcessed = 0;
    let latestSnap: DetectorSnapshot | null = null;
    let latestTdoa: TDOAResult | null = lastTdoaRef.current;
    const newWaveFrames: { l: Float32Array; r: Float32Array }[] = [];

    while (pos + FRAME_SIZE <= targetSample && pos + FRAME_SIZE <= left.length && framesProcessed < maxFrames) {
      const lFrame = left.slice(pos, pos + FRAME_SIZE);
      const rFrame = right.slice(pos, pos + FRAME_SIZE);
      const snap = detectorRef.current.processFrame(lFrame);
      latestSnap = snap;

      if (snap.state === 'CONFIRMED' || snap.state === 'ALERT') {
        const bpCenter = snap.candidateBand === 'HIGH' ? 3300 : 400;
        const bpWidth = snap.candidateBand === 'HIGH' ? 1500 : 500;
        latestTdoa = computeTDOA(bandpassFilter(lFrame, SAMPLE_RATE, bpCenter, bpWidth), bandpassFilter(rFrame, SAMPLE_RATE, bpCenter, bpWidth));
        lastTdoaRef.current = latestTdoa;
      }
      // DON'T null TDOA on IDLE — let it persist visually (cleared by alert timer instead)

      if (framesProcessed % 3 === 0) newWaveFrames.push({ l: lFrame, r: rFrame });

      const entry: LogEntry = {
        timeMs: (pos / SAMPLE_RATE) * 1000, frame: snap.frameIndex,
        state: snap.state, prevState: snap.event.prevState, scr: snap.scr,
        centroid: snap.centroid, hiLoRatio: snap.hiLoRatio,
        band: snap.candidateBand, peakFreq: snap.peakFreq,
        isTransition: snap.event.isTransition,
        direction: latestTdoa?.direction, tdoaLag: latestTdoa?.lag, tdoaAngle: latestTdoa?.angle,
      };
      if (entry.isTransition || snap.frameIndex % 20 === 0) {
        logRef.current = [...logRef.current.slice(-80), entry];
      }

      // Alert persistence logic
      if (snap.state === 'CONFIRMED' || snap.state === 'ALERT') {
        setAlertVisible(true); setAlertFading(false);
        setLastAlertSnap(snap); setLastAlertTdoa(latestTdoa);
        clearTimeout(alertTimerRef.current);
        alertTimerRef.current = window.setTimeout(() => {
          setAlertFading(true);
          window.setTimeout(() => {
            setAlertVisible(false); setAlertFading(false);
            setTdoa(null); // clear TDOA correlogram after fade
          }, 600);
        }, ALERT_PERSIST_MS);
      }

      pos += FRAME_SIZE; framesProcessed++;
    }
    processedUpToRef.current = pos;

    if (latestSnap) {
      setSnapshot(latestSnap); setTdoa(latestTdoa);
      setDetectionCount(latestSnap.detections);
      setBattery(b => Math.max(0, b - framesProcessed * 0.0002));
    }
    if (newWaveFrames.length > 0) setWaveHistory(prev => [...prev, ...newWaveFrames].slice(-40));
    setTimeMs((pos / SAMPLE_RATE) * 1000);
    setLog([...logRef.current]);
  }, []);

  const handleToggle = useCallback(() => { if (isProcessing) setIsPlaying(p => !p); }, [isProcessing]);
  const handleReset = useCallback(() => {
    setIsPlaying(false); processedUpToRef.current = 0;
    detectorRef.current.reset(); lastTdoaRef.current = null; logRef.current = [];
    setSnapshot(null); setTdoa(null); setWaveHistory([]); setLog([]);
    setDetectionCount(0); setTimeMs(0); setBattery(100);
    setAlertVisible(false); setAlertFading(false);
    if (mediaRef.current) mediaRef.current.currentTime = 0;
  }, []);

  // Animation loop — media-driven
  useEffect(() => {
    if (!isPlaying) return;
    const media = mediaRef.current;
    if (media) { media.currentTime = processedUpToRef.current / SAMPLE_RATE; media.play().catch(() => {}); }

    const tick = () => {
      if (!mediaRef.current) return;
      const targetSample = Math.floor(mediaRef.current.currentTime * SAMPLE_RATE);
      if (targetSample > processedUpToRef.current) processUpTo(targetSample);
      if (mediaRef.current.ended) { processUpTo(leftBufRef.current.length); setIsPlaying(false); return; }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animRef.current); if (mediaRef.current) mediaRef.current.pause(); };
  }, [isPlaying, processUpTo]);

  // Draw waveforms
  useEffect(() => {
    const c = waveCanvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const w = c.width, h = c.height, half = h / 2;
    ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    [half / 2, half, half + half / 2].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); });
    if (waveHistory.length === 0) return;
    const totalSamp = waveHistory.reduce((s, f) => s + f.l.length, 0);
    const allL = new Float32Array(totalSamp), allR = new Float32Array(totalSamp);
    let off = 0; for (const f of waveHistory) { allL.set(f.l, off); allR.set(f.r, off); off += f.l.length; }
    const drawTrace = (data: Float32Array, yOff: number, color: string) => {
      const mid = yOff + half / 2;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let px = 0; px < w; px++) { const i = Math.floor((px / w) * data.length); const y = mid - (data[i] || 0) * half * 0.4; px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y); }
      ctx.stroke(); ctx.strokeStyle = color + '30'; ctx.lineWidth = 3; ctx.stroke();
    };
    drawTrace(allL, 0, '#00ff88'); drawTrace(allR, half, '#00ccff');
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillStyle = '#00ff88'; ctx.fillText('MIC L', 8, 16);
    ctx.fillStyle = '#00ccff'; ctx.fillText('MIC R', 8, half + 16);
  }, [waveHistory]);

  // Draw correlogram
  useEffect(() => {
    const c = corrCanvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const w = c.width, h = c.height;
    ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(15, h - 15); ctx.lineTo(w - 5, h - 15); ctx.moveTo(w / 2, 5); ctx.lineTo(w / 2, h - 15); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '10px monospace';
    ctx.fillText('-8', 15, h - 4); ctx.fillText('+8', w - 22, h - 4);
    if (!tdoa) { ctx.fillStyle = '#333'; ctx.font = '13px monospace'; ctx.fillText('Awaiting detection...', w / 2 - 80, h / 2); return; }
    const { correlogram, correlogramLags, lag } = tdoa;
    const maxC = Math.max(...correlogram.map(Math.abs), 0.01), midY = 5 + (h - 20) / 2;
    const dC: Record<string, string> = { LEFT: '#00ccff', RIGHT: '#ff6644', BEHIND: '#ffaa00', FRONT: '#00ff88' };
    const color = dC[tdoa.direction] || '#fff';
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    correlogram.forEach((v, i) => { const x = 15 + (i / (correlogram.length - 1)) * (w - 25); const y = midY - (v / maxC) * (h - 25) * 0.4; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    const pi = correlogramLags.indexOf(lag);
    if (pi >= 0) { const px = 15 + (pi / (correlogram.length - 1)) * (w - 25); const py = midY - (correlogram[pi] / maxC) * (h - 25) * 0.4; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); }
  }, [tdoa]);

  const bins = snapshot?.bins || [];
  const stateColor = (s: DetectionState) => s === 'IDLE' ? '#666' : s === 'CANDIDATE' ? '#ffaa00' : s === 'CONFIRMED' ? '#00ff88' : '#ff4444';
  const dirColors: Record<string, string> = { LEFT: '#00ccff', RIGHT: '#ff6644', BEHIND: '#ffaa00', FRONT: '#00ff88' };

  // For the alert overlay, use last confirmed detection's data
  const alertSnap = lastAlertSnap;
  const alertTdoa = lastAlertTdoa;

  return (
    <div className="app" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* STATUS BAR */}
      <div className="status-bar">
        <div className="status-left">
          {mediaUrl && (
            <button className="back-btn" onClick={() => {
              setIsPlaying(false);
              if (mediaRef.current) mediaRef.current.pause();
              setMediaUrl(null); setFileName(''); setIsProcessing(false);
              processedUpToRef.current = 0; detectorRef.current.reset();
              lastTdoaRef.current = null; logRef.current = [];
              setSnapshot(null); setTdoa(null); setWaveHistory([]); setLog([]);
              setDetectionCount(0); setTimeMs(0); setBattery(100);
              setAlertVisible(false); setAlertFading(false);
            }}>← CLIPS</button>
          )}
          {!mediaUrl && <div className="title-main">HORNERA</div>}
          <div className="title-sub">Dual-Band Goertzel Horn Detection v2.0</div>
        </div>
        <div className="status-center">
          <span className="event-text">{fileName || 'Drop a video/audio file to begin'}</span>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${totalMs > 0 ? (timeMs / totalMs) * 100 : 0}%` }} /></div>
          <div className="time-display">{fmtTime(timeMs)} / {fmtTime(totalMs)}</div>
        </div>
        <div className="status-right">
          <div className="detection-counter">
            <span className="counter-label">DETECTIONS</span>
            <span className="counter-value">{detectionCount}</span>
          </div>
        </div>
      </div>

      {/* LANDING — clip selector + drop zone */}
      {!mediaUrl && (
        <div className="drop-overlay">
          <div className="landing-title">HORNERA</div>
          <div className="landing-sub">Real-Time Goertzel Horn Detection Pipeline</div>

          <div className="demo-clips">
            <div className="demo-clips-label">Demo Clips</div>
            <div className="demo-clips-grid">
              {DEMO_CLIPS.map(clip => (
                <button key={clip.id} className="demo-clip-card" onClick={() => loadFromUrl(clip)}>
                  <img src={clip.thumbUrl} alt={clip.name} className="demo-clip-thumb" />
                  <div className="demo-clip-info">
                    <div className="demo-clip-name">{clip.name}</div>
                    <div className="demo-clip-desc">{clip.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="landing-divider"><span>or</span></div>

          <div className="drop-zone-inner">
            <div className="drop-text">Drop your own video/audio</div>
            <div className="drop-sub">MP4, WebM, WAV, MP3</div>
            <label className="file-input-label">
              Browse files
              <input type="file" accept="video/*,audio/*" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} hidden />
            </label>
          </div>
        </div>
      )}

      <div className="main-layout">
        {/* LEFT: VIDEO with alert overlay */}
        <div className="video-section">
          <div className="video-wrap">
            {mediaUrl && mediaType === 'video' ? (
              <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={mediaUrl} className="video-player" />
            ) : mediaUrl && mediaType === 'audio' ? (
              <div className="audio-placeholder">
                <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={mediaUrl} />
                <div className="audio-icon">🎵</div>
                <div className="audio-name">{fileName}</div>
              </div>
            ) : null}

            {/* Detection badge */}
            {mediaUrl && (
              <div className="video-detection-badge">
                <span className="vdb-label">DETECTIONS</span>
                <span className="vdb-count">{detectionCount}</span>
              </div>
            )}
          </div>

          {/* Media controls bar */}
          {mediaUrl && (
            <div className="media-controls">
              <button className="mc-btn" onClick={handleReset} title="Reset">↺</button>
              <button className="mc-btn mc-play" onClick={handleToggle} disabled={!isProcessing} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <span className="mc-time">{fmtTime(timeMs)}</span>
              <div className="mc-progress">
                <div className="mc-progress-fill" style={{ width: `${totalMs > 0 ? (timeMs / totalMs) * 100 : 0}%` }} />
              </div>
              <span className="mc-time">{fmtTime(totalMs)}</span>
            </div>
          )}

          {/* ALERT OVERLAY — persists for 3 seconds */}
          {alertVisible && alertSnap && (
            <div className={`alert-overlay ${alertFading ? 'fading' : ''}`}>
              {/* Helmet */}
              <div className="alert-helmet">
                <svg viewBox="0 0 100 100" width={80} height={80}>
                  <ellipse cx={50} cy={45} rx={28} ry={32} fill="none" stroke="#555" strokeWidth={2} />
                  {(['LEFT', 'RIGHT', 'BEHIND'] as const).map(zone => {
                    const pos = zone === 'LEFT' ? [18, 42] : zone === 'RIGHT' ? [82, 42] : [50, 82];
                    const active = alertTdoa?.direction === zone;
                    const col = dirColors[zone];
                    return (
                      <g key={zone}>
                        <circle cx={pos[0]} cy={pos[1]} r={9} fill={active ? col + '30' : 'transparent'} stroke={active ? col : '#333'} strokeWidth={active ? 2 : 1} />
                        <text x={pos[0]} y={pos[1] + 3} textAnchor="middle" fill={active ? col : '#444'} fontSize={9} fontWeight={active ? 700 : 400}>{zone[0]}</text>
                        {active && <circle cx={pos[0]} cy={pos[1]} r={9} fill="none" stroke={col} strokeWidth={1}>
                          <animate attributeName="r" from="7" to="16" dur="0.6s" repeatCount="indefinite" />
                          <animate attributeName="opacity" from="0.7" to="0" dur="0.6s" repeatCount="indefinite" />
                        </circle>}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Info */}
              <div className="alert-info">
                <span className="alert-badge">HORN DETECTED</span>
                <div className="alert-freq">{alertSnap.peakFreq}Hz</div>
                <div className="alert-band">{alertSnap.candidateBand === 'HIGH' ? 'SCOOTY HORN (3kHz+)' : 'CAR/TRUCK HORN'}</div>
              </div>

              {/* Direction */}
              {alertTdoa && (
                <div style={{ textAlign: 'right' }}>
                  <div className="alert-direction" style={{ color: dirColors[alertTdoa.direction] }}>
                    → {alertTdoa.direction}
                  </div>
                  <div className="alert-tdoa">
                    lag: <span className="val">{alertTdoa.lag}</span> | θ: <span className="val">{alertTdoa.angle.toFixed(1)}°</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT: PIPELINE */}
        <div className="pipeline-column">
          {/* Waveform */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-number">01</span>
              <span className="panel-title">DUAL MIC INPUT</span>
              <span className="panel-subtitle">DFSDM → DMA</span>
            </div>
            <div className="canvas-wrap"><canvas ref={waveCanvasRef} width={800} height={200} /></div>
          </div>

          {/* Goertzel */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-number">02</span>
              <span className="panel-title">GOERTZEL DUAL-BAND</span>
              <span className="panel-subtitle">LOW 300-600 | HIGH 2.5-3.7k</span>
            </div>
            <div className="goertzel-layout">
              <div className="freq-bars">
                {bins.map(bin => {
                  const maxMag = Math.max(...bins.map(b => b.magSq), 1);
                  const norm = bin.magSq / maxMag;
                  const isSpiking = snapshot && snapshot.state !== 'IDLE' && norm > 0.2;
                  return (
                    <div key={bin.freq} className="freq-bar-container">
                      <div className="freq-bar-track">
                        <div className="freq-bar-fill" style={{
                          height: `${Math.min(100, norm * 100)}%`,
                          backgroundColor: isSpiking ? (bin.band === 'HIGH' ? '#aa66ff' : '#ff8800') : (bin.band === 'HIGH' ? '#2a1a4a' : '#1a3a1a'),
                          boxShadow: isSpiking ? `0 0 8px ${bin.band === 'HIGH' ? '#aa66ff' : '#ff8800'}60` : 'none',
                        }} />
                      </div>
                      <div className="freq-bar-label" style={{ color: bin.band === 'HIGH' ? '#aa88ff' : '#88ff88' }}>
                        {bin.freq >= 1000 ? `${(bin.freq / 1000).toFixed(1)}k` : bin.freq}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="scr-state-section">
                <div className="band-ratios">
                  {[
                    { label: 'CENT', color: '#00ccff', val: (snapshot?.centroid || 0) / 50, display: `${(snapshot?.centroid || 0).toFixed(0)}Hz` },
                    { label: 'H/L', color: '#aa66ff', val: snapshot?.hiLoRatio || 0, display: `${(snapshot?.hiLoRatio || 0).toFixed(2)}` },
                    { label: 'PEAK', color: '#ff8800', val: (snapshot?.peakFreq || 0) / 500, display: `${snapshot?.peakFreq || 0}Hz` },
                    { label: 'SCR', color: '#00ff88', val: (snapshot?.scr || 0) * 10, display: (snapshot?.scr || 0).toFixed(3) },
                  ].map(r => (
                    <div key={r.label} className="ratio-row">
                      <span className="ratio-label" style={{ color: r.color }}>{r.label}</span>
                      <div className="ratio-bar-track"><div className="ratio-bar-fill" style={{ width: `${Math.min(100, r.val / 10 * 100)}%`, backgroundColor: r.color }} /></div>
                      <span className="ratio-val">{r.display}</span>
                    </div>
                  ))}
                </div>
                <div className="state-machine">
                  {(['IDLE', 'CANDIDATE', 'CONFIRMED', 'ALERT'] as DetectionState[]).map(s => (
                    <div key={s} className={`state-box ${snapshot?.state === s ? 'state-active' : ''}`} style={{
                      borderColor: snapshot?.state === s ? stateColor(s) : '#222',
                      color: snapshot?.state === s ? stateColor(s) : '#444',
                      backgroundColor: snapshot?.state === s ? stateColor(s) + '12' : 'transparent',
                    }}>{s}</div>
                  ))}
                </div>
                <div className="computation-log">
                  <div className="log-header">Goertzel Core</div>
                  <div className="log-content">
                    <div className="dim">Frame {snapshot?.frameIndex || 0} | N={FRAME_SIZE} | Fs={SAMPLE_RATE}</div>
                    {bins.length > 0 && [...bins].sort((a, b) => b.magSq - a.magSq).slice(0, 3).map(b => (
                      <div key={b.freq}>
                        <span style={{ color: b.band === 'HIGH' ? '#aa88ff' : '#88ff88' }}>{b.freq}Hz</span>
                        <span className="dim"> k={b.k.toFixed(1)}</span> → <span className="val">|G|²={b.magSq.toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom row: TDOA + MCU side by side */}
          <div className="bottom-row">
            <div className="sub-panel">
              <div className="panel-header">
                <span className="panel-number">03</span>
                <span className="panel-title">TDOA</span>
                <span className="panel-subtitle">d=17cm | ±8 samp</span>
              </div>
              <div className="canvas-wrap"><canvas ref={corrCanvasRef} width={400} height={200} /></div>
            </div>

            <div className="sub-panel">
              <div className="panel-header">
                <span className="panel-number">04</span>
                <span className="panel-title">MCU & TELEMETRY</span>
                <span className="panel-subtitle">STM32L431</span>
              </div>
              <div className="mcu-layout">
                <div className="mcu-diagram">
                  <div className="peripheral-grid">
                    {[{ name: 'DFSDM', on: true }, { name: 'DMA', on: true }, { name: 'CPU', on: snapshot?.state !== 'IDLE' }, { name: 'BLE', on: snapshot?.state === 'ALERT' }].map(p => (
                      <div key={p.name} className={`peripheral-block ${p.on ? 'active' : 'sleep'}`}>
                        <div className="peripheral-name">{p.name}</div>
                        <div className="peripheral-indicator" style={{ backgroundColor: p.on ? '#00ff88' : '#333', boxShadow: p.on ? '0 0 6px #00ff8880' : 'none' }} />
                      </div>
                    ))}
                  </div>
                  <div className="power-stats">
                    <div className="power-row"><span className="dim">Power:</span> <span className="val">{(snapshot?.avgPowerMw || 1.1).toFixed(1)}mW</span></div>
                    <div className="power-row"><span className="dim">Bat:</span> <span className="val">{battery.toFixed(0)}%</span></div>
                    <div className="power-row"><span className="dim">RMS:</span> <span className="val">{(snapshot?.rms || 0).toFixed(4)}</span></div>
                  </div>
                </div>
                <div className="telemetry-log">
                  <div className="log-header-bar"><span>SERIAL 115200</span><span className="log-scrolling">AUTO</span></div>
                  <div className="log-scroll-area" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
                    {log.map((e, i) => (
                      <div key={i} className={`telem-line ${e.isTransition ? 'telem-highlight' : ''}`}>
                        <span className="telem-time">[{fmtTimeShort(e.timeMs)}]</span>{' '}
                        <span className="dim">C:{e.centroid.toFixed(0)} H/L:{e.hiLoRatio.toFixed(1)}</span>{' '}
                        <span style={{ color: stateColor(e.state), fontWeight: e.isTransition ? 700 : 400 }}>
                          {e.isTransition ? `${e.prevState}→${e.state}` : e.state}
                        </span>
                        {e.isTransition && e.state === 'CONFIRMED' && (
                          <span className="telem-haptic"> ■ {e.peakFreq}Hz {e.direction ? `→${e.direction}` : ''}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtTime(ms: number) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function fmtTimeShort(ms: number) { const s = Math.floor(ms / 1000); return `${String(s).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`; }

export default App;
