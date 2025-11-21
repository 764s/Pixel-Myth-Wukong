
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { GameState, Entity, Particle } from '../types';

// --- Game Constants ---
const GRAVITY = 0.6;
const FRICTION = 0.80;
const MOVE_SPEED = 1.2;
const MAX_SPEED = 5;
const JUMP_FORCE = -13;
const GROUND_Y = 400;

const ATTACK_RANGE = 90;
const ATTACK_DAMAGE = 12; 
const COMBO_2_DAMAGE = 18;
// COMBO 3 DAMAGE is now dynamic based on debug params
const COMBO_4_SLAM_DAMAGE = 45; // Main slam damage
const HEAVY_ATTACK_DAMAGE = 60;
const HEAVY_ATTACK_RANGE = 300; 
const AIR_ATTACK_DAMAGE = 8; // Lower damage per tick for multi-hit

const DODGE_SPEED = 18; 
const DODGE_COOLDOWN = 40;
const DODGE_STAMINA_COST = 20;

const BOSS_DAMAGE = 15;
const BOSS_KOWTOW_DAMAGE = 25; // High damage for the slam
const CHARGE_THRESHOLD = 20; 
const COMBO_WINDOW_FRAMES = 50; 

const IMMOBILIZE_BREAK_THRESHOLD = 80; // Damage needed to break the spell early

// Pixel Art Resolution (Physics is 800x450, Canvas is 480x270)
const LOGICAL_WIDTH = 800;
const LOGICAL_HEIGHT = 450;
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 270;
const SCALE_FACTOR = CANVAS_WIDTH / LOGICAL_WIDTH; // 0.6

// --- Math Helpers (Hoisted for shared usage between Update and Draw) ---
const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;
const easeOutQuad = (t: number) => t * (2 - t);
const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
const easeInCubic = (t: number) => t * t * t;

// Combo 4 Configuration
const C4_START_ANGLE = -2.5;
const C4_END_ANGLE = 1.8;
const C4_STAFF_LENGTH = 150;

// Shared logic to get current staff angle based on Continuous Time (t)
// t = animFrame + (animTimer / speed)
const getCombo4AngleFromT = (t: number) => {
    // Active swing is frames 5 to 10
    if (t <= 5) return C4_START_ANGLE; // Windup
    if (t >= 10) return C4_END_ANGLE; // End
    
    const progress = (t - 5) / 5; // 0.0 to 1.0
    const ease = easeInCubic(progress); // Accelerate downwards
    return lerp(C4_START_ANGLE, C4_END_ANGLE, ease);
};

interface GameCanvasProps {
  gameState: GameState;
  setGameState: (state: GameState) => void;
  setPlayerHealth: (h: number) => void;
  setBossHealth: (h: number) => void;
  setStamina: React.Dispatch<React.SetStateAction<number>>;
  setScore: (s: React.SetStateAction<number>) => void;
}

const GameCanvas: React.FC<GameCanvasProps> = ({
  gameState,
  setGameState,
  setPlayerHealth,
  setBossHealth,
  setStamina,
  setScore
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reqRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  
  // Time Step Refs
  const lastTimeRef = useRef<number>(0);
  const accumulatorRef = useRef<number>(0);
  
  // BGM Refs
  const bgmRunningRef = useRef<boolean>(false);
  const nextNoteTimeRef = useRef<number>(0);
  const schedulerTimerRef = useRef<number>(0);
  const currentTickRef = useRef<number>(0);

  // --- DEBUG PARAMS ---
  const debugParamsRef = useRef({
      // Attack 4 (Fan) & Trails
      trailDecay: 0.2,
      trailStep: 0.2,
      fanFade: 0.2,
      fanBrightness: 1.0, 
      fanOpacity: 0.1,    
      
      // Attack 3 (Spin Cross) Visuals
      c3Radius: 100,      
      c3Width: 12,        
      c3Glow: 1.5,        
      c3Density: 0.4,     
      c3Opacity: 0.3,     
      
      // Attack 3 Compensation / Blur
      c3BlurSteps: 1,     // Updated Default: 1
      c3BlurFade: 0.1,    // Updated Default: 0.1

      // Attack 3 Background (Disc)
      c3BgBrightness: 0.1, // Updated Default: 0.1
      c3BgOpacity: 0,      // Updated Default: 0

      // Attack 3 (Spin Cross) Logic
      c3Rotations: 2,     
      c3Speed: 50,        
      c3ExtraHits: 10,    
      c3TotalDamage: 45,  
      c3Stun: 3,          

      bossBehavior: 'normal', 
      infiniteHealth: false,
      infinitePlayerHealth: false
  });
  const [showDebug, setShowDebug] = useState(false);
  const [debugValues, setDebugValues] = useState(debugParamsRef.current);

  // Debug UI State
  const [debugTab, setDebugTab] = useState<'general' | 'skills'>('general');
  const [selectedEntity, setSelectedEntity] = useState<'player' | 'boss'>('player');
  const [selectedSkill, setSelectedSkill] = useState<string>('atk3');

  const updateDebug = (key: keyof typeof debugParamsRef.current, val: any) => {
      debugParamsRef.current = { ...debugParamsRef.current, [key]: val };
      setDebugValues({...debugParamsRef.current});
  };

  // Mutable Game State
  const playerRef = useRef<Entity>({
    id: 'player',
    pos: { x: 100, y: 0 },
    width: 30,
    height: 50,
    vx: 0,
    vy: 0,
    color: '#fbbf24', 
    health: 100,
    maxHealth: 100,
    isDead: false,
    facingRight: true,
    type: 'player',
    state: 'idle',
    attackCooldown: 0,
    dodgeCooldown: 0,
    chargeTimer: 0,
    comboCount: 0,
    comboWindow: 0,
    animFrame: 0,
    animTimer: 0,
    hasHitInAir: false,
    hasDealtDamage: false,
    hitStop: 0,
    spellCooldown: 0
  });

  const bossRef = useRef<Entity | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  
  // NEW: Store real-time trails for Combo 4
  const combo4TrailsRef = useRef<{ angle: number; life: number }[]>([]);
  // Track TIME instead of angle for accurate physics-based interpolation
  const prevCombo4TimeRef = useRef<number | null>(null);
  
  // TRACKER for Combo 3 multi-hits
  const c3HitsRef = useRef<number>(0);

  const keysRef = useRef<{ [key: string]: boolean }>({});
  const cameraXRef = useRef(0);
  const shakeRef = useRef(0);

  // --- FFXIV Style 8-Bit Audio System ---
  
  const stopBGM = useCallback(() => {
    bgmRunningRef.current = false;
    if (schedulerTimerRef.current) {
        cancelAnimationFrame(schedulerTimerRef.current);
        schedulerTimerRef.current = 0;
    }
  }, []);

  const playOscillator = (
      ctx: AudioContext, 
      freq: number, 
      time: number, 
      duration: number, 
      type: OscillatorType, 
      vol: number, 
      envelope: 'pluck' | 'pad' | 'perc' = 'pluck'
  ) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);

    // Filter shaping for 8-bit authenticity
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(envelope === 'perc' ? 800 : 4000, time);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    if (envelope === 'pluck') {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(vol, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.01, time + duration);
    } else if (envelope === 'pad') {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(vol, time + 0.05);
        gain.gain.linearRampToValueAtTime(vol * 0.8, time + 0.2);
        gain.gain.linearRampToValueAtTime(0, time + duration);
    } else if (envelope === 'perc') {
        // Kick/Bass hit
        osc.frequency.setValueAtTime(freq * 2, time);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.5, time + 0.1);
        gain.gain.setValueAtTime(vol, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
    }

    osc.start(time);
    osc.stop(time + duration + 0.1);
  };

  const playNoise = (ctx: AudioContext, time: number, duration: number, vol: number) => {
    const bufSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const gain = ctx.createGain();
    
    // Snare filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1000;

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + duration);
    
    noise.start(time);
  };

  const startBGM = useCallback(() => {
    if (bgmRunningRef.current || !audioCtxRef.current) return;
    
    const ctx = audioCtxRef.current;
    bgmRunningRef.current = true;
    nextNoteTimeRef.current = ctx.currentTime + 0.1;
    currentTickRef.current = 0;

    // "The Primal" - FFXIV Style Rock Boss Theme
    const TEMPO = 170;
    const SEC_PER_BEAT = 60 / TEMPO;
    const SIXTEENTH = SEC_PER_BEAT / 4;

    // Key: E Minor (Heroic/Rock)
    const E2=82.41, G2=98.00, A2=110.00, B2=123.47;
    const D3=146.83, E3=164.81, G3=196.00, A3=220.00, B3=246.94;
    const D4=293.66, E4=329.63, Fs4=369.99, G4=392.00, A4=440.00, B4=493.88;
    const D5=587.33, E5=659.25;

    const bassLine = [
        E2, E2, E2, G2, E2, E2, A2, B2,  E2, E2, E2, G2, E2, D3, B2, A2
    ];

    const melodyLine = [
        E4, 0, B3, 0, G3, 0, E3, 0,  E4, 0, D4, 0, B3, 0, A3, G3, 
        A3, 0, B3, 0, D4, 0, E4, 0,  G4, 0, Fs4, 0, D4, 0, B3, 0,
        E5, 0, 0, 0, B4, 0, 0, 0,    G4, 0, A4, 0, B4, 0, D5, 0,
        E5, 0, D5, 0, B4, 0, A4, 0,  G4, 0, E4, 0, 0, 0, 0, 0
    ];

    const schedule = () => {
        if (!bgmRunningRef.current || !audioCtxRef.current) return;
        
        while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
             const t = nextNoteTimeRef.current;
             const tick = currentTickRef.current;
             
             const beatStep = tick % 16;
             if (beatStep === 0 || beatStep === 4 || beatStep === 7 || beatStep === 10) {
                 playOscillator(ctx, 60, t, 0.1, 'triangle', 0.4, 'perc');
             }
             if (beatStep === 4 || beatStep === 12) {
                 playNoise(ctx, t, 0.08, 0.15);
             }
             if (tick % 2 === 0) {
                 playNoise(ctx, t, 0.01, 0.05);
             }

             const bassNote = bassLine[tick % 16];
             if (bassNote) {
                 playOscillator(ctx, bassNote, t, SIXTEENTH * 0.8, 'sawtooth', 0.15, 'pluck');
             }

             const melodyNote = melodyLine[tick % 32];
             if (melodyNote > 0) {
                 const isLong = (melodyLine[(tick + 1) % 32] === 0);
                 const dur = isLong ? SIXTEENTH * 2 : SIXTEENTH * 0.9;
                 playOscillator(ctx, melodyNote, t, dur, 'square', 0.08, isLong ? 'pad' : 'pluck');
             }

             if (tick % 3 === 0) {
                 const arpNotes = [E4, G4, B4, E5];
                 const an = arpNotes[(tick/3) % 4];
                 playOscillator(ctx, an, t, SIXTEENTH, 'triangle', 0.03, 'pluck');
             }

             nextNoteTimeRef.current += SIXTEENTH;
             currentTickRef.current++;
        }
        schedulerTimerRef.current = requestAnimationFrame(schedule);
    };

    schedule();
  }, []);

  // --- Audio System Init ---
  const initAudio = useCallback(() => {
    if (!audioCtxRef.current) {
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContext) audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume();
    }
    if (gameState === GameState.PLAYING && !bgmRunningRef.current) {
        // startBGM(); // Disabled
    }
  }, [gameState, startBGM]);

  useEffect(() => {
      if (gameState !== GameState.PLAYING) {
          stopBGM();
      }
  }, [gameState, stopBGM]);

  // --- SFX System ---
  const playSound = useCallback((
      type: 'jump' | 'dash' | 'attack_light' | 'attack_heavy' | 'hit' | 'block' | 'charge' | 'spell' | 'hit_heavy' | 'break_spell'
  ) => {
      if (!audioCtxRef.current) return;
      const ctx = audioCtxRef.current;
      const t = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      switch (type) {
          case 'jump':
              playNoise(ctx, t, 0.2, 0.1);
              osc.type = 'sine';
              osc.frequency.setValueAtTime(200, t);
              osc.frequency.linearRampToValueAtTime(800, t + 0.2);
              gain.gain.setValueAtTime(0.1, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.2);
              osc.start(t);
              osc.stop(t + 0.3);
              break;
          case 'dash':
              const dBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
              const dd = dBuf.getChannelData(0);
              for(let i=0; i<dBuf.length; i++) dd[i] = (Math.random() * 2 - 1);
              const dSrc = ctx.createBufferSource();
              dSrc.buffer = dBuf;
              const dFilt = ctx.createBiquadFilter();
              dFilt.type = 'bandpass';
              dFilt.frequency.setValueAtTime(800, t);
              dFilt.frequency.exponentialRampToValueAtTime(3000, t + 0.1);
              dSrc.connect(dFilt);
              dFilt.connect(gain);
              gain.connect(ctx.destination);
              gain.gain.setValueAtTime(0.3, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.15);
              dSrc.start(t);
              break;
          case 'attack_light':
              osc.type = 'square'; 
              osc.frequency.setValueAtTime(880, t);
              osc.frequency.exponentialRampToValueAtTime(110, t + 0.1);
              gain.gain.setValueAtTime(0.08, t);
              gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              osc.start(t);
              osc.stop(t + 0.15);
              break;
           case 'attack_heavy':
              osc.type = 'sawtooth';
              osc.frequency.setValueAtTime(220, t);
              osc.frequency.linearRampToValueAtTime(55, t + 0.3);
              gain.gain.setValueAtTime(0.2, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.3);
              osc.start(t);
              osc.stop(t + 0.35);
              break;
          case 'hit':
              osc.type = 'triangle';
              osc.frequency.setValueAtTime(150, t);
              osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
              gain.gain.setValueAtTime(0.3, t);
              gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
              osc.start(t);
              osc.stop(t + 0.2);
              const sOsc = ctx.createOscillator();
              const sGain = ctx.createGain();
              sOsc.type = 'sine';
              sOsc.frequency.setValueAtTime(2000, t);
              sOsc.frequency.linearRampToValueAtTime(1000, t + 0.1);
              sGain.gain.setValueAtTime(0.1, t);
              sGain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              sOsc.connect(sGain);
              sGain.connect(ctx.destination);
              sOsc.start(t);
              sOsc.stop(t + 0.15);
              break;
          case 'hit_heavy':
               osc.type = 'triangle';
               osc.frequency.setValueAtTime(100, t);
               osc.frequency.exponentialRampToValueAtTime(20, t + 0.4);
               gain.gain.setValueAtTime(0.8, t);
               gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
               osc.start(t);
               osc.stop(t + 0.5);
               const nBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
               const nd = nBuf.getChannelData(0);
               for(let i=0; i<nBuf.length; i++) nd[i] = (Math.random() * 2 - 1);
               const nSrc = ctx.createBufferSource();
               nSrc.buffer = nBuf;
               const nFilt = ctx.createBiquadFilter();
               nFilt.type = 'lowpass';
               nFilt.frequency.setValueAtTime(300, t);
               nFilt.frequency.linearRampToValueAtTime(100, t + 0.3);
               const nGain = ctx.createGain();
               nSrc.connect(nFilt);
               nFilt.connect(nGain);
               nGain.connect(ctx.destination);
               nGain.gain.setValueAtTime(0.6, t);
               nGain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
               nSrc.start(t);
               break;
          case 'charge':
              osc.type = 'sine';
              osc.frequency.setValueAtTime(440, t);
              osc.frequency.linearRampToValueAtTime(1760, t + 0.3);
              const tremolo = ctx.createOscillator();
              tremolo.frequency.value = 20;
              const tremGain = ctx.createGain();
              tremGain.gain.value = 0.5;
              tremolo.connect(tremGain);
              tremGain.connect(gain.gain);
              gain.gain.setValueAtTime(0.05, t);
              gain.gain.linearRampToValueAtTime(0.1, t + 0.2);
              gain.gain.linearRampToValueAtTime(0, t + 0.3);
              osc.start(t);
              osc.stop(t + 0.3);
              tremolo.start(t);
              tremolo.stop(t + 0.3);
              break;
          case 'spell':
             const osc1 = ctx.createOscillator();
             osc1.type = 'sine';
             osc1.frequency.setValueAtTime(2500, t); 
             osc1.frequency.exponentialRampToValueAtTime(1000, t + 0.3);
             osc1.connect(gain);
             const osc2 = ctx.createOscillator();
             osc2.type = 'triangle';
             osc2.frequency.setValueAtTime(4000, t); 
             osc2.frequency.exponentialRampToValueAtTime(500, t + 0.1);
             osc2.connect(gain);
             gain.gain.setValueAtTime(0.4, t);
             gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5); 
             osc1.start(t);
             osc1.stop(t+1.5);
             osc2.start(t);
             osc2.stop(t+1.5);
             break;
          case 'break_spell':
             const snapOsc = ctx.createOscillator();
             snapOsc.type = 'sine';
             snapOsc.frequency.setValueAtTime(2500, t); 
             snapOsc.frequency.exponentialRampToValueAtTime(100, t + 0.1); 
             const snapG = ctx.createGain();
             snapG.gain.setValueAtTime(0.5, t);
             snapG.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
             snapOsc.connect(snapG);
             snapG.connect(ctx.destination);
             snapOsc.start(t);
             snapOsc.stop(t + 0.15);
             const shardOsc = ctx.createOscillator();
             shardOsc.type = 'triangle';
             shardOsc.frequency.setValueAtTime(4000, t); 
             shardOsc.detune.setValueAtTime(500, t); 
             const shardG = ctx.createGain();
             shardG.gain.setValueAtTime(0.3, t);
             shardG.gain.exponentialRampToValueAtTime(0.01, t + 0.2); 
             shardOsc.connect(shardG);
             shardG.connect(ctx.destination);
             shardOsc.start(t);
             shardOsc.stop(t + 0.25);
             const dustBuf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
             const dustData = dustBuf.getChannelData(0);
             for(let i=0; i<dustBuf.length; i++) dustData[i] = (Math.random() * 2 - 1);
             const dustSrc = ctx.createBufferSource();
             dustSrc.buffer = dustBuf;
             const dustFilt = ctx.createBiquadFilter();
             dustFilt.type = 'highpass';
             dustFilt.frequency.value = 6000; 
             const dustG = ctx.createGain();
             dustG.gain.setValueAtTime(0.4, t);
             dustG.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
             dustSrc.connect(dustFilt);
             dustFilt.connect(dustG);
             dustG.connect(ctx.destination);
             dustSrc.start(t);
             break;
      }
  }, []);

  // --- Input Handling ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') e.preventDefault(); // Prevent scrolling
      keysRef.current[e.code] = true;
      initAudio(); 
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.code] = false;
    };
    const handleClick = () => initAudio();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('click', handleClick);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('click', handleClick);
    };
  }, [initAudio]);

  // --- Initialization ---
  const initGame = useCallback(() => {
    playerRef.current = {
      ...playerRef.current,
      pos: { x: 100, y: 200 },
      health: 100,
      vx: 0,
      vy: 0,
      state: 'idle',
      isDead: false,
      animFrame: 0,
      animTimer: 0,
      attackCooldown: 0,
      dodgeCooldown: 0,
      chargeTimer: 0,
      comboCount: 0,
      comboWindow: 0,
      hasHitInAir: false,
      hasDealtDamage: false,
      hitStop: 0,
      spellCooldown: 0
    };
    
    bossRef.current = {
      id: 'boss',
      pos: { x: 600, y: 200 },
      width: 80,
      height: 100,
      vx: 0,
      vy: 0,
      color: '#581c87', 
      health: 1200, 
      maxHealth: 1200,
      isDead: false,
      facingRight: false,
      type: 'boss',
      state: 'idle',
      attackCooldown: 60, 
      dodgeCooldown: 0,
      chargeTimer: 0,
      comboCount: 0,
      comboWindow: 0,
      animFrame: 0,
      animTimer: 0,
      hitStop: 0,
      isImmobilized: false,
      immobilizeTimer: 0,
      immobilizeDamageTaken: 0
    };

    particlesRef.current = [];
    combo4TrailsRef.current = [];
    prevCombo4TimeRef.current = null;
    cameraXRef.current = 0;
    shakeRef.current = 0;
    c3HitsRef.current = 0;

    setPlayerHealth(100);
    setBossHealth(1200);
    setStamina(100);
    setScore(0);
    
  }, [setPlayerHealth, setBossHealth, setStamina, setScore]);

  useEffect(() => {
    if (gameState === GameState.PLAYING) {
      initGame();
    }
  }, [gameState, initGame]);

  // --- Helper: Particles ---
  const createParticles = (x: number, y: number, color: string, count: number, speed: number = 10) => {
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x, y,
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        life: 1.0,
        color,
        size: Math.random() * 3 + 2
      });
    }
  };

  // --- Helper: Collision Resolution ---
  const resolveEntityCollision = (e1: Entity, e2: Entity) => {
    if (e1.state === 'dodge' || e2.state === 'dodge') return;
    
    const p1Frozen = e1.hitStop > 0 && !e1.isImmobilized;
    const p2Frozen = e2.hitStop > 0 && !e2.isImmobilized;
    if (p1Frozen || p2Frozen) return;

    if (
        e1.pos.x < e2.pos.x + e2.width &&
        e1.pos.x + e1.width > e2.pos.x &&
        e1.pos.y < e2.pos.y + e2.height &&
        e1.pos.y + e1.height > e2.pos.y
    ) {
        const center1 = e1.pos.x + e1.width / 2;
        const center2 = e2.pos.x + e2.width / 2;
        const pushForce = 2; 

        if (center1 < center2) {
            e1.pos.x -= pushForce;
            if (e2.type === 'boss') {
                if (!e2.isImmobilized && e2.state !== 'kowtow_attack') e2.vx = 0;
            } else {
                e2.pos.x += pushForce;
            }
            if (e1.vx > 0) e1.vx = 0;
        } else {
            e1.pos.x += pushForce;
            if (e2.type === 'boss') {
                if (!e2.isImmobilized && e2.state !== 'kowtow_attack') e2.vx = 0;
            } else {
                e2.pos.x -= pushForce;
            }
            if (e1.vx < 0) e1.vx = 0;
        }
    }
  };

  // --- Main Game Loop ---
  const update = useCallback(() => {
    if (gameState !== GameState.PLAYING) return;

    if (shakeRef.current > 0) shakeRef.current *= 0.9;
    if (shakeRef.current < 0.5) shakeRef.current = 0;

    const player = playerRef.current;
    const boss = bossRef.current;
    
    // Debug values
    const { 
        trailDecay, trailStep, bossBehavior, infiniteHealth, infinitePlayerHealth,
        c3Rotations, c3Speed, c3ExtraHits, c3TotalDamage, c3Stun, c3Radius
    } = debugParamsRef.current;

    // --- 1. Player Logic ---
    if (player.hitStop > 0) {
        player.hitStop--;
    } else if (!player.isDead) {
      const onGround = player.pos.y + player.height >= GROUND_Y;
      
      if (player.attackCooldown > 0) player.attackCooldown--;
      if (player.dodgeCooldown > 0) player.dodgeCooldown--;
      if (player.comboWindow > 0) player.comboWindow--;
      if (player.spellCooldown && player.spellCooldown > 0) player.spellCooldown--;

      if (player.comboWindow === 0 && player.state !== 'attack') {
          player.comboCount = 0;
      }

      // --- TRAIL SYSTEM UPDATE (REAL TIME) ---
      // Update existing trails (Decay)
      for (let i = combo4TrailsRef.current.length - 1; i >= 0; i--) {
          combo4TrailsRef.current[i].life -= trailDecay; 
          if (combo4TrailsRef.current[i].life <= 0) {
              combo4TrailsRef.current.splice(i, 1);
          }
      }

      // Generate new trails for Combo 4 with Time-based Supersampling
      if (player.state === 'attack' && player.comboCount === 4) {
          // Calculate continuous time 't'
          const speed = 1; // Hardcoded speed for Combo 4
          const currentT = player.animFrame + (player.animTimer / speed);

          // Active swing frames: 5 to 10. 
          // hitStop must be 0 (moving) to generate new trails.
          if (player.animFrame >= 5 && player.animFrame <= 10 && player.hitStop <= 0) {
               
               if (prevCombo4TimeRef.current === null) {
                   prevCombo4TimeRef.current = currentT;
                   // Initial trail
                   combo4TrailsRef.current.push({
                       angle: getCombo4AngleFromT(currentT),
                       life: 0.5 // Slightly lower starting life
                   });
               } else {
                   const prevT = prevCombo4TimeRef.current;
                   
                   // If time has advanced, fill the gap
                   if (currentT > prevT) {
                       // Density: Generate a trail every 'step' time units
                       let simT = prevT + trailStep;
                       
                       while (simT <= currentT) {
                           const angle = getCombo4AngleFromT(simT);
                           
                           // Age Compensation
                           const age = currentT - simT;
                           const lifeStart = 0.5 - (age * trailDecay); // Adjusted to match decay
                           
                           if (lifeStart > 0) {
                               combo4TrailsRef.current.push({
                                   angle: angle,
                                   life: lifeStart
                               });
                           }
                           simT += trailStep;
                       }
                   }
                   prevCombo4TimeRef.current = currentT;
               }
          } else {
              // If outside swing window or frozen, reset logic if completely done
              if (player.animFrame > 10 || player.animFrame < 5) {
                  prevCombo4TimeRef.current = null;
              }
          }
      } else {
          prevCombo4TimeRef.current = null;
      }

      const isAttackPressed = keysRef.current['KeyJ'];
      const isDodgePressed = keysRef.current['ShiftLeft'] || keysRef.current['KeyL']; 
      const isSpellPressed = keysRef.current['KeyK'];

      // --- Spell Logic (Immobilize) ---
      if (isSpellPressed && (!player.spellCooldown || player.spellCooldown <= 0) && boss && !boss.isDead) {
           const dist = boss.pos.x - player.pos.x;
           const range = 600; 
           const facingTarget = (player.facingRight && dist > 0) || (!player.facingRight && dist < 0);
           
           if (facingTarget && Math.abs(dist) < range) {
               boss.isImmobilized = true;
               boss.immobilizeTimer = 300; 
               boss.immobilizeDamageTaken = 0; 
               playSound('spell');
               
               const pCx = player.pos.x + player.width/2;
               const pCy = player.pos.y + player.height/2;
               const bCx = boss.pos.x + boss.width/2;
               const bCy = boss.pos.y + boss.height/2;
               const cX = (pCx + bCx) / 2;
               const cY = (pCy + bCy) / 2 - 40; 
               
               const particleCount = 24;
               for(let i=0; i<=particleCount; i++) {
                   const t = i / particleCount;
                   const invT = 1 - t;
                   const lx = (invT * invT * pCx) + (2 * invT * t * cX) + (t * t * bCx);
                   const ly = (invT * invT * pCy) + (2 * invT * t * cY) + (t * t * bCy);
                   
                   const scatter = 8; 
                   const offsetX = (Math.random() - 0.5) * scatter;
                   const offsetY = (Math.random() - 0.5) * scatter;

                   particlesRef.current.push({
                       x: lx + offsetX,
                       y: ly + offsetY,
                       vx: (Math.random() - 0.5) * 0.2, 
                       vy: -Math.random() * 0.5, 
                       life: 0.4 + Math.random() * 0.3, 
                       color: Math.random() > 0.5 ? '#fbbf24' : '#fef3c7', 
                       size: Math.random() * 2 + 0.5 
                   });
               }
               createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, '#fbbf24', 30, 4);
               player.spellCooldown = 30; 
           }
      }

      if (isDodgePressed && player.dodgeCooldown <= 0 && player.state !== 'dodge' && player.state !== 'hit') {
          player.state = 'dodge';
          player.animFrame = 0;
          player.vx = player.facingRight ? DODGE_SPEED : -DODGE_SPEED;
          player.dodgeCooldown = DODGE_COOLDOWN;
          player.chargeTimer = 0;
          setStamina((prev) => Math.max(0, prev - DODGE_STAMINA_COST));
          playSound('dash');
          createParticles(player.pos.x + player.width/2, player.pos.y + player.height, '#fff', 5);
      }
      else if (player.state !== 'dodge' && player.state !== 'hit') {
        if (isAttackPressed) {
           if (player.state !== 'attack' && player.state !== 'heavy_attack') {
             player.chargeTimer++;
             if (player.chargeTimer % 8 === 0) playSound('charge'); 
             if (player.chargeTimer > CHARGE_THRESHOLD && player.chargeTimer % 5 === 0) {
                createParticles(player.pos.x + player.width/2, player.pos.y + player.height/2, '#fbbf24', 1, 2);
             }
           }
        }
        else if (!isAttackPressed && player.chargeTimer > 0) {
            if (player.chargeTimer > CHARGE_THRESHOLD) {
                player.state = 'heavy_attack';
                player.attackCooldown = 30;
                player.animFrame = 0;
                player.vx = player.facingRight ? 12 : -12; 
                player.comboCount = 0; 
                player.hasDealtDamage = false;
                setStamina(0);
                playSound('attack_heavy');
            } 
            else {
                const isAlreadyAttacking = player.state === 'attack' || player.state === 'heavy_attack' || player.state === 'air_attack';
                const isCurrentlyAirAttack = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);
                
                let allowAttack = true;
                if (!onGround && isCurrentlyAirAttack) {
                    if (player.state === 'air_attack') {
                        allowAttack = true;
                    } else {
                        if (!player.hasHitInAir) allowAttack = false;
                        else player.hasHitInAir = false; 
                    }
                }

                if (!isAlreadyAttacking || allowAttack) {
                   player.hasDealtDamage = false; 

                   if (onGround) {
                       player.state = 'attack';
                       if (player.comboCount > 0) {
                           player.comboCount = (player.comboCount % 4) + 1;
                       } else {
                           player.comboCount = 1;
                       }
                       
                       if (player.comboCount === 3) player.vy = -5.5; 
                       if (player.comboCount === 4) {
                           player.vy = -5; 
                           player.attackCooldown = 30; 
                       }
                       
                       let lunge = 3;
                       if (player.comboCount === 2) lunge = 6;
                       if (player.comboCount === 3) lunge = 4;
                       if (player.comboCount === 4) lunge = 2;

                       player.vx = player.facingRight ? lunge : -lunge;
                       playSound('attack_light');
                       
                       // Init Combo 3 tracker
                       if (player.comboCount === 3) {
                           c3HitsRef.current = 0;
                       }
                   } else {
                       if ((player.comboCount === 3 || player.state === 'air_attack')) {
                            player.state = 'attack';
                            player.comboCount = 4; 
                            player.vy = -5; 
                            player.vx = 0;
                            player.attackCooldown = 30;
                            player.animFrame = 0;
                            player.hasDealtDamage = false;
                            playSound('attack_heavy');
                       } 
                       else {
                           const distToGround = GROUND_Y - (player.pos.y + player.height);
                           if (distToGround > 50) { 
                                player.state = 'air_attack';
                                player.comboCount = 0; 
                                player.vy = -4;
                                player.attackCooldown = 15;
                                playSound('attack_light');
                           } else {
                                player.chargeTimer = 0;
                                return; 
                           }
                       }
                   }
                   
                   if (player.attackCooldown === 0) {
                       if (player.comboCount === 1 || player.comboCount === 2) player.attackCooldown = 7;
                       else player.attackCooldown = 11;
                   }
                   if (player.comboCount === 3) player.attackCooldown = 0; 

                   player.animFrame = 0;
                }
            }
            player.chargeTimer = 0;
        }
      } else {
          if (!isAttackPressed) player.chargeTimer = 0;
      }

      let moving = false;
      const isFinisher = player.state === 'attack' && player.comboCount === 4;
      const movementLocked = player.state === 'dodge' || player.state === 'heavy_attack' || isFinisher;

      if (!movementLocked) {
        const attackLockFrames = 5;
        const isAttackLocked = (player.state === 'attack' && player.comboCount !== 3 && player.animFrame < 2);

        if (!isAttackLocked) {
            if (keysRef.current['ArrowRight'] || keysRef.current['KeyD']) {
            player.vx += MOVE_SPEED;
            player.facingRight = true;
            moving = true;
            } else if (keysRef.current['ArrowLeft'] || keysRef.current['KeyA']) {
            player.vx -= MOVE_SPEED;
            player.facingRight = false;
            moving = true;
            } else {
            player.vx *= FRICTION;
            }
            player.vx = Math.max(Math.min(player.vx, MAX_SPEED), -MAX_SPEED);
        }
      } else if (player.state === 'dodge') {
         if (Math.abs(player.vx) < 1) player.state = 'idle';
      } else if (player.state === 'heavy_attack') {
         player.vx *= 0.85; 
      } else if (isFinisher) {
         player.vx *= 0.90; 
      }

      if ((keysRef.current['Space']) && onGround && !movementLocked && player.state !== 'attack') {
        player.vy = JUMP_FORCE;
        playSound('jump');
        createParticles(player.pos.x + player.width/2, player.pos.y + player.height, '#78350f', 5); 
      }

      if (player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3)) {
         player.vy += GRAVITY * 0.25; 
      } else {
         player.vy += GRAVITY;
      }
      
      player.pos.x += player.vx;
      player.pos.y += player.vy;

      if (player.pos.y + player.height > GROUND_Y) {
        player.pos.y = GROUND_Y - player.height;
        player.vy = 0;
        player.hasHitInAir = false; 
      }
      if (player.pos.x < 0) player.pos.x = 0;
      if (player.pos.x > 1200) player.pos.x = 1200;

      const isAttacking = (player.state === 'attack' || player.state === 'heavy_attack' || player.state === 'air_attack');
      let activeFrames = false;
      
      // --- COMBO 3 DYNAMIC LOGIC ---
      // Calculate end frame based on degrees and speed
      // Total Degrees = c3Rotations * 360
      // Duration = TotalDegrees / c3Speed
      const c3TotalFrames = Math.ceil((c3Rotations * 360) / c3Speed);
      
      if (player.state === 'heavy_attack') activeFrames = player.animFrame >= 2 && player.animFrame <= 6; 
      else if (player.state === 'attack') {
          if (player.comboCount === 1 || player.comboCount === 2) activeFrames = player.animFrame === 1 || player.animFrame === 2;
          else if (player.comboCount === 3) {
              // Combo 3 acts active for the calculated duration
              activeFrames = player.animFrame <= c3TotalFrames;
          }
          else if (player.comboCount === 4) activeFrames = player.animFrame >= 5 && player.animFrame <= 10; 
      } 
      else if (player.state === 'air_attack') activeFrames = true;

      if (isAttacking && activeFrames && boss && !boss.isDead) {
          let range = ATTACK_RANGE;
          let damage = ATTACK_DAMAGE;
          let isAir = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);
          let isMultiHit = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);

          if (player.state === 'heavy_attack') {
              range = HEAVY_ATTACK_RANGE;
              damage = HEAVY_ATTACK_DAMAGE;
          } else if (isAir) {
              if (player.state === 'attack' && player.comboCount === 3) {
                  // --- COMBO 3 PARAMETERS ---
                  range = c3Radius; // Use debug parameter for range
                  const totalHits = 1 + c3ExtraHits;
                  damage = c3TotalDamage / totalHits; // Distribute damage

                  // Multi-hit Reset Logic
                  // Divide total frames into segments. At start of each segment, reset damage.
                  const segmentLen = c3TotalFrames / totalHits;
                  const currentHitIndex = Math.floor(player.animFrame / segmentLen);
                  
                  if (currentHitIndex > c3HitsRef.current) {
                      player.hasDealtDamage = false;
                      c3HitsRef.current = currentHitIndex;
                  }
              } else {
                  damage = AIR_ATTACK_DAMAGE;
                  range = ATTACK_RANGE * 1.5;
              }
          } else if (player.state === 'attack') {
              if (player.comboCount === 2) { damage = COMBO_2_DAMAGE; range = ATTACK_RANGE * 1.2; }
              if (player.comboCount === 4) {
                  damage = COMBO_4_SLAM_DAMAGE;
                  range = ATTACK_RANGE * 2.0;
              }
          }
          
          let hit = false;

          // Advanced Collision for Combo 4 (Sweep Detection)
          if (player.state === 'attack' && player.comboCount === 4) {
               const speed = 1;
               const currentT = player.animFrame + (player.animTimer / speed);
               
               // SWEEP: Check collision from previous frame to current frame
               const prevT = Math.max(5, currentT - 1.0);
               const sweepSteps = 6; 

               const pivotX = player.pos.x + player.width/2;
               const pivotY = player.pos.y + player.height - 35;
               const checkPoints = [40, 80, 120, 150]; 
               
               for (let s = 0; s <= sweepSteps; s++) {
                   if (hit) break; 
                   const t = lerp(prevT, currentT, s / sweepSteps);
                   const angle = getCombo4AngleFromT(t);
                   for (const r of checkPoints) {
                       const dir = player.facingRight ? 1 : -1;
                       const px = pivotX + (Math.cos(angle) * r * dir);
                       const py = pivotY + (Math.sin(angle) * r);
                       if (
                           px >= boss.pos.x && px <= boss.pos.x + boss.width &&
                           py >= boss.pos.y && py <= boss.pos.y + boss.height
                       ) {
                           hit = true;
                           if (!player.hasDealtDamage) { 
                                createParticles(px, py, '#fff', 2, 5);
                           }
                           break;
                       }
                   }
               }
          } 
          else {
              const pCx = player.pos.x + player.width/2;
              const pCy = player.pos.y + player.height/2;
              const bCx = boss.pos.x + boss.width/2;
              const bCy = boss.pos.y + boss.height/2;

              if (isAir) {
                  // Update collision for Combo 3: Include Boss Dimensions
                  const dist = Math.sqrt(Math.pow(pCx - bCx, 2) + Math.pow(pCy - bCy, 2));
                  const effectiveRange = range + (Math.min(boss.width, boss.height) / 2);
                  
                  if (dist < effectiveRange) hit = true;
              } else {
                  let attackBoxX = player.facingRight ? player.pos.x + player.width : player.pos.x - range;
                  let attackBoxW = range;
                  let attackBoxY = player.pos.y;
                  let attackBoxH = player.height;

                  if (player.state === 'heavy_attack') {
                      const slamReach = 250; 
                      attackBoxH += slamReach;
                      const backBuffer = 40; 
                      if (player.facingRight) {
                          attackBoxX = player.pos.x - backBuffer;
                          attackBoxW = range + player.width + backBuffer;
                      } else {
                          attackBoxX = player.pos.x - range;
                          attackBoxW = range + player.width + backBuffer;
                      }
                  }

                  if (
                    attackBoxX < boss.pos.x + boss.width &&
                    attackBoxX + attackBoxW > boss.pos.x &&
                    attackBoxY < boss.pos.y + boss.height &&
                    attackBoxY + attackBoxH > boss.pos.y
                  ) {
                      hit = true;
                  }
              }
          }

          if (hit) {
              if (isAir || player.state === 'air_attack') {
                  player.hasHitInAir = true;
              }

              let shouldRegisterHit = false;
              if (isMultiHit) {
                   if (!player.hasDealtDamage) {
                       shouldRegisterHit = true;
                   }
              } else {
                   if (!player.hasDealtDamage) {
                       shouldRegisterHit = true;
                   }
              }

              if (shouldRegisterHit) { 
                 // INFINITE HEALTH LOGIC (INTERCEPT BEFORE APPLYING DAMAGE)
                 if (infiniteHealth && boss.health - damage <= 0) {
                     boss.health = boss.maxHealth; 
                     // Do not apply damage that kills
                 } else {
                     boss.health -= damage;
                 }

                 const isHeavyHit = player.state === 'heavy_attack' || player.comboCount === 4;

                 if (boss.isImmobilized) {
                    boss.immobilizeDamageTaken = (boss.immobilizeDamageTaken || 0) + damage;

                    if (boss.immobilizeDamageTaken > IMMOBILIZE_BREAK_THRESHOLD) {
                        boss.isImmobilized = false;
                        boss.immobilizeDamageTaken = 0;
                        boss.immobilizeTimer = 0;

                        playSound('break_spell'); 
                        shakeRef.current = 25; 
                        
                        for(let i=0; i<25; i++) {
                            particlesRef.current.push({
                                x: boss.pos.x + boss.width/2,
                                y: boss.pos.y + boss.height/2,
                                vx: (Math.random() - 0.5) * 18,
                                vy: (Math.random() - 0.5) * 18,
                                life: 1.2,
                                color: '#fbbf24',
                                size: Math.random() * 4 + 3
                            });
                        }

                        boss.state = 'hit';
                        boss.animFrame = 0;
                        boss.vx = player.facingRight ? 8 : -8; 

                        let stopDuration = 10;
                        if (isHeavyHit) stopDuration = 15;
                        else if (isMultiHit) stopDuration = 8;
                        
                        const finalStun = Math.max(stopDuration, 18);
                        player.hitStop = finalStun;
                        boss.hitStop = finalStun;

                    } else {
                        playSound(isHeavyHit ? 'hit_heavy' : 'hit');
                        shakeRef.current = 5;
                        createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, '#fbbf24', 8, 5);
                        
                        player.hitStop = 3;
                        boss.hitStop = 3;
                    }
                 } else {
                     let kForce = 0; 
                     if (player.comboCount === 4) kForce = 8; 
                     if (player.state === 'heavy_attack') kForce = 12; 
                     
                     boss.vx = player.facingRight ? kForce : -kForce;
                     
                     let stopDuration = 10; 
                     let shakeInt = 5;

                     const shouldStagger = player.state === 'heavy_attack' || player.comboCount === 4;

                     if (player.state === 'heavy_attack') {
                         stopDuration = 15; 
                         shakeInt = 20;
                         createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height, '#fff', 20, 15);
                     } else if (player.comboCount === 4) {
                         stopDuration = 12;
                         shakeInt = 20;
                         createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height, '#fff', 20, 15);
                     } else if (isMultiHit) {
                         if (player.comboCount === 3) {
                             stopDuration = c3Stun; // Use debug param for stun
                             shakeInt = 2; 
                         } else {
                             stopDuration = 8; 
                             shakeInt = 5;
                         }
                     } else if (player.comboCount === 1 || player.comboCount === 2) {
                         stopDuration = 4; 
                     }

                     // Apply Stagger if configured
                     if (shouldStagger) {
                         boss.state = 'hit';
                         boss.animTimer = 0;
                     }

                     player.hitStop = stopDuration; 
                     boss.hitStop = stopDuration;

                     shakeRef.current = shakeInt; 
                     playSound(isHeavyHit ? 'hit_heavy' : 'hit');
                 }

                 setBossHealth(boss.health);
                 
                 const pColor = (player.state === 'heavy_attack' || player.comboCount === 4) ? '#ef4444' : '#fbbf24';
                 createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, pColor, 12); 
                 
                 setScore(s => s + Math.floor(damage));
                 
                 if (isMultiHit) {
                     if (player.comboCount === 3) {
                         player.attackCooldown = 11;
                     } else {
                         player.attackCooldown = 18; 
                     }
                     player.hasDealtDamage = true; // Set flag to wait for next reset cycle
                 } else {
                     player.hasDealtDamage = true;
                  }
              }
          }
      }

      player.animTimer++;

      if (player.state === 'hit') {
          if (player.animFrame > 3) {
              player.state = 'idle';
              player.animFrame = 0;
          }
      }
      else if (player.state === 'dodge' && player.animFrame >= 4) {
        player.state = 'idle';
      }
      else if (player.state === 'heavy_attack' && player.animFrame >= 8) {
         player.state = 'idle';
      }
      else if (isAttacking && player.attackCooldown <= 0 && !isFinisher && player.state !== 'heavy_attack' && player.state !== 'air_attack' && player.comboCount !== 3) {
        player.state = 'idle';
        player.comboWindow = COMBO_WINDOW_FRAMES;
      }
      else if (player.state !== 'dodge' && !isAttacking) {
        if (!onGround) {
           player.state = player.vy > 0 ? 'fall' : 'jump';
        } else if (Math.abs(player.vx) > 0.1) {
           player.state = 'run';
        } else {
           player.state = 'idle';
        }
      }
      
      if (player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3)) {
           // DYNAMIC LIMIT for Combo 3
           const limit = player.comboCount === 3 ? c3TotalFrames : 18; 
           
           if (player.animFrame > limit) { 
               if (player.comboCount === 3) {
                   player.state = 'attack';
                   player.comboCount = 4;
                   player.vy = -5; 
                   player.vx = 0;
                   player.attackCooldown = 30;
                   player.animFrame = 0;
                   player.animTimer = 0;
                   player.hasDealtDamage = false;
                   playSound('attack_heavy');
               } else {
                   player.state = 'idle';
                   player.comboWindow = COMBO_WINDOW_FRAMES;
               }
           }
      }
      if (isFinisher && player.animFrame >= 20) {
          player.state = 'idle';
          player.comboWindow = COMBO_WINDOW_FRAMES;
      }

      let animSpeed = 8;
      if (player.state === 'run') animSpeed = 5;
      if (player.state === 'attack') {
          if (player.comboCount === 3) animSpeed = 1; 
          else if (player.comboCount === 4) animSpeed = 1; 
          else animSpeed = 3; 
      }
      if (player.state === 'heavy_attack') animSpeed = 2; 
      if (player.state === 'dodge') animSpeed = 3;
      if (player.state === 'hit') animSpeed = 10;
      if (player.state === 'air_attack') animSpeed = 2; 
      
      if (player.animTimer > animSpeed) {
        player.animFrame++;
        player.animTimer = 0;
      }
      
      if (player.dodgeCooldown < 30) {
         setStamina(s => Math.min(100, s + 0.5));
      }
    }

    // --- 2. Boss Logic ---
    if (boss && !boss.isDead) {
      if (boss.hitStop > 0) boss.hitStop--;

      // Only apply AI Decision overrides if not reacting to damage
      const isReacting = boss.state === 'hit' || boss.hitStop > 0 || boss.isImmobilized;
      
      if (!isReacting) {
          // Debug Behavior Override
          if (bossBehavior === 'idle') {
              if (boss.state !== 'idle') {
                   boss.state = 'idle';
                   boss.vx = 0;
              }
              boss.attackCooldown = 60;
          } 
          else if (bossBehavior === 'kowtow') {
              // Force kowtow loop
              if (boss.state !== 'kowtow_attack') {
                  boss.state = 'kowtow_attack';
                  boss.animFrame = 0;
                  boss.animTimer = 0;
                  boss.vx = 0;
              }
          }
      }

      if (boss.isImmobilized) {
          if (boss.immobilizeTimer && boss.immobilizeTimer > 0) {
             boss.immobilizeTimer--;
             const flickerRate = 10;
             if (boss.immobilizeTimer % flickerRate === 0) {
                 createParticles(boss.pos.x + Math.random()*boss.width, boss.pos.y + Math.random()*boss.height, '#fbbf24', 1, 1);
             }
          } else {
             boss.isImmobilized = false;
          }
      } else {
        if (boss.hitStop <= 0) {
            if (boss.state !== 'kowtow_attack') {
                boss.facingRight = player.pos.x > boss.pos.x;
            }

            const distance = Math.abs(player.pos.x - boss.pos.x);
            const PREFERRED_DISTANCE = 220;
            
            // Normal AI logic only if not forced to idle/kowtow loop via debug
            if (bossBehavior === 'normal') {
                const isBusy = ['attack', 'jump_smash', 'hit', 'kowtow_attack'].includes(boss.state);
                if (!isBusy) {
                    if (boss.attackCooldown <= 0) {
                        boss.state = 'kowtow_attack';
                        boss.animFrame = 0;
                        boss.animTimer = 0;
                        boss.vx = 0; 
                    }
                }
            }

            if (boss.state === 'kowtow_attack') {
                // Friction to stop sliding if knocked back
                if (Math.abs(boss.vx) > 0.1) boss.vx *= 0.8;
                else boss.vx = 0;

                const IMPACT_FRAME = 4;
                
                if (boss.animFrame === IMPACT_FRAME && boss.animTimer === 0) { 
                     playSound('hit_heavy');
                     shakeRef.current = 15;
                     
                     const headX = boss.facingRight ? boss.pos.x + boss.width + 40 : boss.pos.x - 40;
                     const headY = GROUND_Y;
                     
                     createParticles(headX, headY, '#a855f7', 8, 12); 
                     createParticles(headX, headY, '#ffffff', 8, 8); 
                     
                     const shockwaveRange = 150;
                     const particleLifeFrames = 20;
                     const swSpeed = shockwaveRange / particleLifeFrames; 
                     
                     for(let i=0; i<12; i++) { 
                         particlesRef.current.push({
                             x: headX, 
                             y: headY - 2,
                             vx: swSpeed * (0.8 + Math.random() * 0.4), 
                             vy: (Math.random() - 0.5) * 2 - 1, 
                             life: 1.0,
                             color: i % 2 === 0 ? 'rgba(120, 113, 108, 0.8)' : 'rgba(168, 162, 158, 0.5)', 
                             size: 2 + Math.random() * 4 
                         });
                         particlesRef.current.push({
                             x: headX, 
                             y: headY - 2,
                             vx: -swSpeed * (0.8 + Math.random() * 0.4),
                             vy: (Math.random() - 0.5) * 2 - 1,
                             life: 1.0,
                             color: i % 2 === 0 ? 'rgba(120, 113, 108, 0.8)' : 'rgba(168, 162, 158, 0.5)',
                             size: 2 + Math.random() * 4
                         });
                     }
                     
                     const range = shockwaveRange; 
                     const dist = Math.abs((player.pos.x + player.width/2) - headX);
                     const vertDist = Math.abs((player.pos.y + player.height) - headY);
                     
                     if (dist < range && vertDist < 40 && player.state !== 'dodge') {
                          // INFINITE PLAYER HEALTH LOGIC (INTERCEPT BEFORE DAMAGE)
                          if (infinitePlayerHealth && player.health - BOSS_KOWTOW_DAMAGE <= 0) {
                              player.health = player.maxHealth;
                          } else {
                              player.health -= BOSS_KOWTOW_DAMAGE;
                          }

                          player.state = 'hit';
                          player.hitStop = 15;
                          player.vy = -10; 
                          player.vx = boss.facingRight ? 8 : -8; 
                          setPlayerHealth(player.health);
                          createParticles(player.pos.x, player.pos.y, '#ef4444', 8);
                          if (player.health <= 0) {
                                player.isDead = true;
                                setGameState(GameState.GAME_OVER);
                          }
                     }
                }

                if (boss.animFrame > 12) {
                    boss.state = 'idle';
                    boss.animFrame = 0;
                    boss.attackCooldown = 60; 
                    if (bossBehavior === 'kowtow') boss.attackCooldown = 0; // Reset instantly for loop
                }
            }
            else if (boss.state !== 'hit') {
                // Only allow these state transitions if behavior is normal
                if (bossBehavior === 'normal') {
                    if (boss.state === 'run' && distance < 250 && distance > 100 && Math.random() < 0.02 && boss.attackCooldown <= 0) {
                        boss.state = 'jump_smash'; 
                        boss.vy = -15; 
                        boss.vx = boss.facingRight ? 8 : -8;
                        boss.attackCooldown = 150;
                    }
                    else if (boss.state === 'run') {
                        if (distance < 350 && distance > 200 && Math.random() < 0.05) {
                            boss.state = 'standoff';
                            boss.animTimer = 0;
                        }
                        if (distance < PREFERRED_DISTANCE) {
                            boss.state = 'standoff';
                        }
                    }

                    if (boss.state === 'jump_smash') {
                        if (boss.pos.y + boss.height >= GROUND_Y) {
                            boss.state = 'attack'; 
                            shakeRef.current = 10;
                            createParticles(boss.pos.x + boss.width/2, GROUND_Y, '#581c87', 10);
                            if (distance < 150 && player.pos.y + player.height >= GROUND_Y - 20 && player.state !== 'dodge') {
                                // INFINITE PLAYER HEALTH LOGIC (INTERCEPT BEFORE DAMAGE)
                                const dmg = BOSS_DAMAGE * 1.5;
                                if (infinitePlayerHealth && player.health - dmg <= 0) {
                                    player.health = player.maxHealth;
                                } else {
                                    player.health -= dmg;
                                }

                                player.vx = boss.facingRight ? 15 : -15;
                                player.vy = -5;
                                player.state = 'hit';
                                player.hitStop = 12; 
                                boss.hitStop = 8; 
                                setPlayerHealth(player.health);
                                if (player.health <= 0) {
                                    player.isDead = true;
                                    setGameState(GameState.GAME_OVER);
                                }
                            }
                            setTimeout(() => { if(boss.state === 'attack') boss.state = 'idle'; }, 500);
                        }
                    }
                    else if (boss.state === 'standoff') {
                        const diff = distance - PREFERRED_DISTANCE;
                        const tolerance = 30; 
                        if (diff < -tolerance) {
                            boss.vx = boss.facingRight ? -1.5 : 1.5;
                            boss.state = 'run'; 
                        } else if (diff > tolerance) {
                            boss.vx = boss.facingRight ? 1.0 : -1.0;
                            boss.state = 'run'; 
                        } else {
                            boss.vx = 0;
                            if (Math.random() < 0.01) boss.state = 'idle'; 
                        }
                    }
                    else if (boss.state !== 'attack') {
                        if (distance > 350) {
                            boss.vx += boss.facingRight ? 0.2 : -0.2;
                            boss.vx = Math.max(Math.min(boss.vx, 2), -2);
                            boss.state = 'run';
                        } else {
                            boss.state = 'standoff';
                        }
                    }
                }
            } else if (boss.state === 'hit') {
                boss.vx *= 0.9;
                if (Math.abs(boss.vx) < 0.1) boss.state = 'idle';
                if (boss.state === 'hit' && boss.animTimer > 20) {
                    boss.state = 'idle';
                }
            }
            
            if (boss.attackCooldown > 0) boss.attackCooldown--;
            boss.vy += GRAVITY;
            boss.pos.x += boss.vx;
            boss.pos.y += boss.vy;
            
            if (boss.pos.y + boss.height > GROUND_Y) {
                boss.pos.y = GROUND_Y - boss.height;
                boss.vy = 0;
            }
            boss.pos.x = Math.max(0, Math.min(boss.pos.x, 1200 - boss.width));

            let bossAnimSpeed = 10;
            if (boss.state === 'kowtow_attack') bossAnimSpeed = 6; 
            if (boss.state === 'hit') bossAnimSpeed = 5;
            
            boss.animTimer++;
            if (boss.animTimer > bossAnimSpeed) {
                boss.animFrame++;
                boss.animTimer = 0;
            }
        } 
      }
    }
      
    if (boss.health <= 0) {
        if (infiniteHealth) {
             // Already handled in collision, but safe fallback check
             boss.health = boss.maxHealth;
             setBossHealth(boss.maxHealth);
        } else {
            boss.isDead = true;
            setGameState(GameState.VICTORY);
        }
    }

    if (boss && !boss.isDead && !player.isDead) {
        resolveEntityCollision(player, boss);
    }

    for (let i = particlesRef.current.length - 1; i >= 0; i--) {
      const p = particlesRef.current[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.05;
      if (p.life <= 0) particlesRef.current.splice(i, 1);
    }

    if (Math.random() < 0.1) {
         particlesRef.current.push({
            x: cameraXRef.current + Math.random() * 800,
            y: Math.random() * 450,
            vx: (Math.random() - 0.5) * 0.5,
            vy: -Math.random() * 1,
            life: 2.0,
            color: '#4b5563', 
            size: Math.random() * 2
         });
    }

    let targetCamX = player.pos.x - 150;
    const VIEWPORT_W = LOGICAL_WIDTH;
    
    if (boss && !boss.isDead) {
        const dist = Math.abs(boss.pos.x - player.pos.x);
        if (dist < VIEWPORT_W) {
            const midX = (player.pos.x + boss.pos.x) / 2;
            const idealCamX = midX - VIEWPORT_W / 2;
            const MARGIN = 150;
            const minCamX = player.pos.x - (VIEWPORT_W - MARGIN); 
            const maxCamX = player.pos.x - MARGIN;                
            targetCamX = Math.max(minCamX, Math.min(idealCamX, maxCamX));
        }
    }

    cameraXRef.current += (targetCamX - cameraXRef.current) * 0.1;
    cameraXRef.current = Math.max(0, Math.min(cameraXRef.current, 600)); 

  }, [gameState, setGameState, setPlayerHealth, setBossHealth, setStamina, setScore, playSound]);

  // --- Drawing Helpers ---
  const drawRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };

  const drawPlayer = (ctx: CanvasRenderingContext2D, p: Entity) => {
    const { width: w, height: h, state, animFrame, comboCount, hitStop } = p;
    const { 
        fanFade, fanBrightness, fanOpacity,
        c3Radius, c3Width, c3Glow, c3Density, c3Opacity, c3Speed,
        c3BgBrightness, c3BgOpacity, c3BlurSteps, c3BlurFade
    } = debugParamsRef.current;
    
    // Using speed=1 for combo count 4 to match update logic
    let speed = 8;
    if (p.state === 'run') speed = 5;
    if (p.state === 'attack') {
        if (p.comboCount === 3) speed = 1; 
        else if (p.comboCount === 4) speed = 1; 
        else speed = 3; 
    }
    if (p.state === 'heavy_attack') speed = 2;
    if (p.state === 'dodge') speed = 3;
    if (p.state === 'hit') speed = 10;
    if (p.state === 'air_attack') speed = 2;

    const smoothT = Math.min(1, p.animTimer / speed);
    const smoothFrame = animFrame + smoothT;

    ctx.save();
    
    let shakeX = 0;
    let shakeY = 0;
    if (state === 'hit' && hitStop > 0) {
        shakeX = (Math.random() - 0.5) * 4;
        shakeY = (Math.random() - 0.5) * 4;
    }
    
    ctx.translate(Math.round(p.pos.x + w / 2 + shakeX), Math.round(p.pos.y + h + shakeY));
    if (!p.facingRight) {
        ctx.scale(-1, 1);
    }

    const cFur = '#8d5c2a';
    const cArmor = '#d97706'; 
    const cCloth = '#1c1917'; 
    const cRed = '#dc2626'; 
    const cSkin = '#fcd34d';
    const cGold = '#fbbf24'; 
    const cStaff = '#262626';

    if (state === 'idle') {
        const bob = Math.sin(Date.now() / 200) * 1; 
        drawRect(ctx, -14, -48 + bob, 8, 35, cRed); 
        drawRect(ctx, -9, -38 + bob, 18, 28, cArmor); 
        drawRect(ctx, -7, -48 + bob, 14, 12, cFur); 
        drawRect(ctx, -6, -46 + bob, 9, 8, cSkin);
        drawRect(ctx, 10, -50 + bob, 3, 50, cStaff); 
    }
    else if (state === 'run') {
        const cycle = animFrame % 4; 
        const legL = cycle === 0 ? -8 : (cycle === 2 ? 8 : 0);
        const bob = cycle % 2 !== 0 ? -2 : 0;
        ctx.save();
        ctx.rotate(0.1); 
        drawRect(ctx, -20 - (cycle===0?4:0), -45 + bob, 12, 25, cRed);
        drawRect(ctx, -9, -38 + bob, 18, 25, cArmor);
        drawRect(ctx, -6, -48 + bob, 14, 12, cFur);
        drawRect(ctx, -5, -46 + bob, 9, 8, cSkin);
        ctx.restore();
        
        drawRect(ctx, -4 + legL, -15, 6, 15, cCloth);
        
        ctx.save();
        ctx.translate(0, -30);
        ctx.rotate(0.4 + Math.sin(Date.now()/100)*0.1);
        drawRect(ctx, -20, -5, 50, 3, cStaff);
        ctx.restore();
    }
    else if (state === 'jump' || state === 'fall') {
        drawRect(ctx, -14, -50, 12, 30, cRed);
        drawRect(ctx, -9, -40, 18, 25, cArmor);
        drawRect(ctx, -7, -50, 14, 12, cFur);
        drawRect(ctx, -6, -48, 9, 8, cSkin);
        ctx.save();
        ctx.translate(0, -35);
        ctx.rotate(-0.5);
        drawRect(ctx, -10, -25, 3, 50, cStaff);
        ctx.restore();
    }
    else if (state === 'attack') {
        if (comboCount === 1) {
             const t = Math.min(3, smoothFrame);
             
             let lean = 0;
             if (t < 1) lean = lerp(0, 0.25, easeOutQuad(t));
             else lean = lerp(0.25, 0, (t-1)/2);

             let ext = 0;
             if (t < 1.2) ext = lerp(0, 40, easeOutQuad(t/1.2));
             else ext = lerp(40, 0, (t-1.2)/1.8);

             ctx.save();
             ctx.rotate(lean);
             
             drawRect(ctx, -15, -45, 15, 20, cRed);
             drawRect(ctx, -9, -35, 18, 25, cArmor);
             drawRect(ctx, -5, -45, 14, 12, cFur);
             drawRect(ctx, -3, -43, 9, 8, cSkin);
             
             ctx.translate(0, -35); 
             ctx.rotate(0.1 - ext * 0.002);
             
             drawRect(ctx, 10 + ext, -2, 70, 6, cGold); 
             drawRect(ctx, -10 + ext, -2, 30, 5, cStaff); 
             
             ctx.restore();
        }
        else if (comboCount === 2) {
             const t = Math.min(3, smoothFrame);
             
             let twist = lerp(-0.1, 0.3, easeInOutQuad(t/2.5));
             
             const startAngle = -2.2;
             const endAngle = 1.5;
             let angle = lerp(startAngle, endAngle, easeInOutQuad(Math.min(1, t/2)));

             ctx.save();
             ctx.rotate(twist);
             
             drawRect(ctx, -25, -45, 15, 20, cRed);
             drawRect(ctx, -9, -35, 18, 25, cArmor);
             drawRect(ctx, -5, -45, 14, 12, cFur);
             drawRect(ctx, -3, -43, 9, 8, cSkin);
             
             ctx.translate(0, -35);
             ctx.rotate(angle);
             
             drawRect(ctx, 10, -3, 90, 6, cGold); 
             drawRect(ctx, -20, -3, 30, 6, cStaff);
             
             ctx.restore();
        }
        else if (comboCount === 3) {
            // --- COMBO 3 RENDER LOGIC ---
            
            ctx.translate(0, -35); // Centered on player chest/hand

            const halfLen = c3Radius;
            const thick = c3Width;

            // DRAW BACKGROUND DISC
            if (c3BgOpacity > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = c3BgOpacity;
                ctx.fillStyle = '#b45309'; 
                ctx.beginPath();
                ctx.arc(0, 0, c3Radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
            if (c3BgBrightness > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = c3BgBrightness;
                ctx.fillStyle = '#fbbf24'; 
                ctx.shadowColor = '#fbbf24';
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.arc(0, 0, c3Radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Helper to draw a single cross (used for both entity and motion trails)
            const drawCross = (angleRad: number, alphaMult: number) => {
                ctx.save();
                ctx.rotate(angleRad);
                
                // Pass 1: Density (Base Color / Opacity)
                if (c3Density > 0) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over'; 
                    ctx.globalAlpha = c3Density * c3Opacity * alphaMult;
                    ctx.fillStyle = '#b45309'; 
                    ctx.fillRect(-thick/2, -halfLen, thick, halfLen*2);
                    ctx.fillRect(-halfLen, -thick/2, halfLen*2, thick);
                    ctx.restore();
                }

                // Pass 2: Glow (Additive)
                if (c3Glow > 0) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter'; 
                    ctx.shadowColor = '#fbbf24';
                    ctx.shadowBlur = 20; 
                    ctx.globalAlpha = c3Glow * c3Opacity * alphaMult;
                    ctx.fillStyle = '#fbbf24'; 
                    ctx.fillRect(-thick/2, -halfLen, thick, halfLen*2);
                    ctx.fillRect(-halfLen, -thick/2, halfLen*2, thick);
                    ctx.restore();
                }
                ctx.restore();
            };

            const currentAngleDeg = (smoothFrame * c3Speed);
            const currentAngleRad = currentAngleDeg * (Math.PI / 180);
            
            // Draw Motion Blur Compensation (Past Frames)
            // Logic: Distribute steps uniformly between current frame angle and previous frame angle
            // to simulate high speed rotation without gaps.
            const steps = Math.floor(c3BlurSteps);
            
            // Calculate gap based on speed (degrees per frame)
            // Distribute steps evenly within the arc traveled in 1 frame (speed)
            // e.g. speed 50, steps 1 -> interval 25.
            const blurIntervalDeg = c3Speed / (steps + 1);

            for (let i = 1; i <= steps; i++) {
                const lagDeg = i * blurIntervalDeg;
                const drawAngleRad = (currentAngleDeg - lagDeg) * (Math.PI / 180);
                
                // Calculate opacity based on fade parameter
                // If c3BlurFade is 0, alpha remains 1.0
                const alpha = Math.max(0, 1.0 - (i * c3BlurFade));
                
                drawCross(drawAngleRad, alpha);
            }
            
            // Draw Main Cross (Entity)
            drawCross(currentAngleRad, 1.0);
            
            // Draw Center Highlight (Static)
            ctx.save();
            ctx.fillStyle = '#fff';
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(0,0, thick/2, 0, Math.PI*2);
            ctx.fill();
            ctx.restore();
        }
        else if (comboCount === 4) {
            const t = smoothFrame; 

            ctx.save();
            let lean = -0.4; 
            if (t > 5) lean = lerp(-0.4, 0.4, easeOutQuad(Math.min(1, (t-5)/5))); 
            ctx.rotate(lean); 

            drawRect(ctx, -25, -45, 15, 20, cRed);
            drawRect(ctx, -9, -35, 18, 25, cArmor);
            drawRect(ctx, -5, -45, 14, 12, cFur);
            drawRect(ctx, -3, -43, 9, 8, cSkin);
            ctx.restore();

            ctx.save();
            ctx.translate(0, -35); 
            
            const currentT = animFrame + (p.animTimer / 1);
            const currentAngle = getCombo4AngleFromT(currentT);

            // Faint Background Fan (Dynamic Expansion)
            if (animFrame >= 5) {
                // Calculate fade decay
                let fadeFactor = 1.0;
                if (animFrame >= 10) {
                    fadeFactor = Math.max(0, 1 - (animFrame - 10) * fanFade);
                }

                const currentOpacity = fanOpacity * fadeFactor;
                const currentBrightness = fanBrightness * fadeFactor;
                
                // Dynamic expansion: Fan grows from Start to Current angle
                const fanEndAngle = Math.max(C4_START_ANGLE, Math.min(C4_END_ANGLE, currentAngle));

                // PASS 1: Density/Opacity (Source Over) - Creates the solid backing
                if (currentOpacity > 0) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.globalAlpha = currentOpacity * 0.3; // Reduced density multiplier to keep it subtle
                    ctx.fillStyle = '#b45309'; // Darker Amber/Gold for density

                    ctx.beginPath();
                    ctx.moveTo(0,0);
                    ctx.arc(0, 0, C4_STAFF_LENGTH, C4_START_ANGLE, fanEndAngle);
                    ctx.fill();
                    ctx.restore();
                }

                // PASS 2: Brightness/Glow (Lighter/Additive) - Creates the magical glow
                if (currentBrightness > 0) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter'; 
                    ctx.shadowColor = '#fbbf24';
                    ctx.shadowBlur = 15; 
                    // Apply fanOpacity to glow as well so it acts as master transparency
                    ctx.globalAlpha = currentBrightness * fanOpacity; 
                    ctx.fillStyle = '#fbbf24'; 
                    
                    ctx.beginPath();
                    ctx.moveTo(0,0);
                    ctx.arc(0, 0, C4_STAFF_LENGTH, C4_START_ANGLE, fanEndAngle);
                    ctx.fill();
                    ctx.restore();
                }
            }

            // Render interpolated trails
            if (combo4TrailsRef.current.length > 0) {
                // Use 'lighten' composition to prevent ugly dark overlaps
                ctx.globalCompositeOperation = 'lighten';
                
                combo4TrailsRef.current.forEach(trail => {
                     ctx.save();
                     ctx.rotate(trail.angle);
                     
                     ctx.fillStyle = cGold;
                     ctx.globalAlpha = Math.max(0, trail.life);
                     
                     ctx.fillRect(0, -6, 150, 12); 
                     
                     ctx.restore();
                });
                ctx.globalAlpha = 1.0;
                ctx.globalCompositeOperation = 'source-over';
            }

            ctx.rotate(currentAngle);
            
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 15; 
            drawRect(ctx, -10, -5, 150, 12, cGold); 
            ctx.shadowBlur = 0;
            
            ctx.restore();
        }
    }
    else if (state === 'air_attack') {
        const angle = (smoothFrame * 60) * (Math.PI / 180); 
        ctx.translate(0, -25);
        ctx.rotate(angle);
        
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 15; 
        ctx.fillStyle = cGold;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, 80, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'source-over';

        drawRect(ctx, -60, -3, 120, 6, cStaff);
        drawRect(ctx, -3, -60, 6, 120, cGold);
        ctx.rotate(-angle); 
        drawRect(ctx, -10, -10, 20, 20, cArmor);
    }
    else if (state === 'heavy_attack') {
        const t = Math.min(8, smoothFrame);
        
        ctx.save();
        ctx.transform(1, 0, -0.3, 1, 0, 0); 
        drawRect(ctx, -10, -38, 20, 38, cArmor);
        ctx.restore();
        
        const maxLen = 300;
        let currentLen = 40;
        if (t < 6) currentLen = lerp(40, maxLen, easeOutQuad(t/6)); 
        else currentLen = maxLen;

        ctx.fillStyle = cGold;
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 25;
        ctx.globalCompositeOperation = 'lighter';
        drawRect(ctx, 0, -35, currentLen, 12, cGold);
        drawRect(ctx, currentLen, -38, 20, 18, '#fcd34d');
        
        ctx.globalCompositeOperation = 'source-over';
        ctx.shadowBlur = 0;
        drawRect(ctx, -20, -32, 30, 6, cStaff);
    }
    else if (state === 'dodge') {
        ctx.globalAlpha = 0.4; 
        drawRect(ctx, -15, -25, 30, 15, cArmor); 
        ctx.fillStyle = '#fff';
        drawRect(ctx, -40, -10, 30, 2, '#fff');
        drawRect(ctx, -30, -30, 20, 2, '#fff');
        ctx.globalAlpha = 1.0;
    }
    else if (state === 'hit') {
        ctx.globalAlpha = 0.8;
        drawRect(ctx, -10, -40, 20, 40, animFrame % 2 === 0 ? '#fff' : '#ef4444');
        ctx.globalAlpha = 1.0;
    }

    ctx.restore();
  };

  // --- Drawing ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(SCALE_FACTOR, SCALE_FACTOR);

    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    
    const grad = ctx.createLinearGradient(0, 0, 0, LOGICAL_HEIGHT);
    grad.addColorStop(0, '#050505');
    grad.addColorStop(1, '#1c1917');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    ctx.save();
    
    const shakeX = (Math.random() - 0.5) * shakeRef.current;
    const shakeY = (Math.random() - 0.5) * shakeRef.current;
    ctx.translate(-cameraXRef.current + shakeX, shakeY);

    ctx.shadowColor = '#f8fafc'; 
    ctx.shadowBlur = 60;
    ctx.fillStyle = '#e5e7eb'; 
    ctx.beginPath();
    ctx.arc(cameraXRef.current + 600, 150, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0; 

    ctx.fillStyle = '#000'; 
    ctx.fillRect(0, GROUND_Y, 2000, 200);
    ctx.fillStyle = '#27272a'; 
    ctx.fillRect(0, GROUND_Y, 2000, 4);

    const b = bossRef.current;
    if (b && !b.isDead) {
        const bx = b.pos.x;
        const by = b.pos.y;
        
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.ellipse(bx + b.width/2, by + b.height, b.width/1.5, 10, 0, 0, Math.PI*2);
        ctx.fill();
        
        let bossShakeX = 0;
        let bossShakeY = 0;
        
        // ALWAYS shake if hitstop is active (visual feedback for impact)
        if (b.hitStop > 0 && !b.isImmobilized) {
            bossShakeX = (Math.random() - 0.5) * 6;
            bossShakeY = (Math.random() - 0.5) * 6;
        }

        ctx.save();
        ctx.translate(bossShakeX, bossShakeY);
        
        if (b.state === 'kowtow_attack') {
             const originX = bx + b.width / 2;
             const originY = by + b.height;
             ctx.translate(originX, originY);
             
             const dir = b.facingRight ? 1 : -1;
             
             let angle = 0;
             const frame = b.animFrame;
             
             if (frame <= 3) {
                 angle = lerp(0, -0.4 * dir, frame/3);
             } 
             else if (frame === 4) {
                 angle = 1.6 * dir; 
             }
             else {
                 angle = lerp(1.6 * dir, 0, (frame - 5)/7);
             }
             
             ctx.rotate(angle);
             ctx.translate(-originX, -originY);
        }

        const isFlashing = !b.isImmobilized && 
                           b.hitStop > 0 && 
                           (b.hitStop % 5 > 2); 

        if (isFlashing) {
             ctx.fillStyle = '#fff'; 
             ctx.fillRect(bx, by, b.width, b.height);
        } else {
            let bColor = b.state === 'jump_smash' ? '#7e22ce' : '#581c87';
            let bAccent = '#3b0764';
            
            if (b.isImmobilized) {
                bColor = '#fbbf24'; 
                bAccent = '#d97706'; 
                
                ctx.shadowColor = '#fbbf24';
                ctx.shadowBlur = 15;
            }
            
            drawRect(ctx, bx, by, b.width, b.height, bColor); 
            drawRect(ctx, bx - 10, by + 10, 20, 60, bAccent); 
            drawRect(ctx, bx + b.width - 10, by + 10, 20, 60, bAccent);
            
            ctx.shadowBlur = 0;
            
            drawRect(ctx, b.facingRight ? bx + b.width - 30 : bx + 10, by + 20, 10, 5, '#ef4444');
            
            if (b.state === 'standoff') {
                drawRect(ctx, bx + 20, by - 20, 10, 10, '#ef4444'); 
                drawRect(ctx, bx + 40, by - 20, 10, 10, '#ef4444');
            }
        }
        
        if (b.state === 'jump_smash') {
             ctx.fillStyle = 'rgba(0,0,0,0.2)';
             ctx.beginPath();
             ctx.ellipse(bx + b.width/2, GROUND_Y, 40, 10, 0, 0, Math.PI*2);
             ctx.fill();
        }

        if (b.health < b.maxHealth) {
            drawRect(ctx, bx, by - 20, b.width, 5, '#7f1d1d');
            drawRect(ctx, bx, by - 20, (b.health/b.maxHealth)*b.width, 5, '#dc2626');
        }
        ctx.restore();
    }

    drawPlayer(ctx, playerRef.current);

    ctx.globalCompositeOperation = 'lighter';
    particlesRef.current.forEach(part => {
        ctx.globalAlpha = part.life;
        ctx.fillStyle = part.color;
        ctx.shadowColor = part.color;
        ctx.shadowBlur = 15; 
        ctx.fillRect(part.x, part.y, part.size, part.size);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
    });
    ctx.globalCompositeOperation = 'source-over';

    ctx.restore(); 
    ctx.restore(); 

  }, []);

  useEffect(() => {
    const FIXED_TIME_STEP = 1000 / 60;

    const loop = (timestamp: number) => {
      if (lastTimeRef.current === 0) {
          lastTimeRef.current = timestamp;
      }
      const deltaTime = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;
      
      accumulatorRef.current += deltaTime;

      if (accumulatorRef.current > 100) accumulatorRef.current = 100;

      while (accumulatorRef.current >= FIXED_TIME_STEP) {
        update();
        accumulatorRef.current -= FIXED_TIME_STEP;
      }
      
      draw();
      reqRef.current = requestAnimationFrame(loop);
    };

    if (gameState === GameState.PLAYING) {
      lastTimeRef.current = 0;
      accumulatorRef.current = 0;
      reqRef.current = requestAnimationFrame(loop);
    } else {
      draw();
    }

    return () => cancelAnimationFrame(reqRef.current);
  }, [gameState, update, draw]);

  // Reset Logic
  const resetHealth = () => {
      if (playerRef.current) setPlayerHealth(playerRef.current.maxHealth);
      if (bossRef.current) setBossHealth(bossRef.current.maxHealth);
      if (playerRef.current) playerRef.current.health = playerRef.current.maxHealth;
      if (bossRef.current) bossRef.current.health = bossRef.current.maxHealth;
  }

  return (
    <div className="relative w-full h-full">
        <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="w-full h-full object-contain bg-neutral-900 shadow-2xl"
        />
        
        {/* Debug UI Toggle */}
        {gameState === GameState.PLAYING && (
            <>
                <button 
                    onClick={() => setShowDebug(!showDebug)}
                    className="absolute top-2 left-2 bg-neutral-900/80 text-gray-400 w-8 h-8 flex items-center justify-center rounded-full border border-gray-700 hover:text-white hover:bg-gray-800 z-20 transition-all"
                >
                    ⚙️
                </button>

                {showDebug && (
                    <div className="absolute top-12 left-2 bg-neutral-900/95 rounded border border-gray-700 text-xs text-gray-300 w-[600px] shadow-xl backdrop-blur z-20 overflow-hidden flex flex-col">
                        
                        {/* Tabs */}
                        <div className="flex border-b border-gray-700 bg-gray-800/50">
                            <button 
                                onClick={() => setDebugTab('general')}
                                className={`flex-1 py-2 text-center font-bold tracking-wider uppercase transition-colors ${debugTab === 'general' ? 'bg-neutral-700/50 text-yellow-500' : 'text-gray-500 hover:bg-gray-800'}`}
                            >
                                General
                            </button>
                            <button 
                                onClick={() => setDebugTab('skills')}
                                className={`flex-1 py-2 text-center font-bold tracking-wider uppercase transition-colors ${debugTab === 'skills' ? 'bg-neutral-700/50 text-yellow-500' : 'text-gray-500 hover:bg-gray-800'}`}
                            >
                                Skills
                            </button>
                        </div>

                        {/* Tab Content */}
                        <div className="p-4 min-h-[300px]">
                            
                            {/* GENERAL TAB */}
                            {debugTab === 'general' && (
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-2">
                                        <h3 className="font-bold text-gray-400 uppercase text-[10px] tracking-widest mb-1 border-b border-gray-800 pb-1">Boss Behavior</h3>
                                        <div className="flex gap-2">
                                            {['normal', 'idle', 'kowtow'].map(b => (
                                                <button
                                                    key={b}
                                                    onClick={() => updateDebug('bossBehavior', b)}
                                                    className={`px-3 py-1 rounded border ${debugValues.bossBehavior === b ? 'border-yellow-600 bg-yellow-900/30 text-yellow-500' : 'border-gray-700 bg-gray-800 text-gray-400'}`}
                                                >
                                                    {b.charAt(0).toUpperCase() + b.slice(1)}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <h3 className="font-bold text-gray-400 uppercase text-[10px] tracking-widest mb-1 border-b border-gray-800 pb-1">Cheats</h3>
                                        <label className="flex items-center gap-2 cursor-pointer p-2 bg-gray-800/30 rounded border border-gray-800 hover:border-gray-600">
                                            <input 
                                                type="checkbox"
                                                checked={debugValues.infinitePlayerHealth}
                                                onChange={(e) => updateDebug('infinitePlayerHealth', e.target.checked)}
                                                className="accent-yellow-600"
                                            />
                                            <span>Infinite Player Health</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer p-2 bg-gray-800/30 rounded border border-gray-800 hover:border-gray-600">
                                            <input 
                                                type="checkbox"
                                                checked={debugValues.infiniteHealth}
                                                onChange={(e) => updateDebug('infiniteHealth', e.target.checked)}
                                                className="accent-yellow-600"
                                            />
                                            <span>Infinite Boss Health</span>
                                        </label>
                                    </div>

                                    <div className="mt-4 pt-4 border-t border-gray-700">
                                         <button 
                                            onClick={resetHealth}
                                            className="w-full py-2 bg-red-900/30 border border-red-800 text-red-400 hover:bg-red-900/50 rounded uppercase tracking-widest font-bold"
                                        >
                                            Reset All Health
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* SKILLS TAB */}
                            {debugTab === 'skills' && (
                                <div className="grid grid-cols-12 gap-4 h-full">
                                    
                                    {/* COL 1: Entity Select */}
                                    <div className="col-span-3 border-r border-gray-700 flex flex-col gap-1 pr-2">
                                        <h4 className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Role</h4>
                                        <button 
                                            onClick={() => setSelectedEntity('player')}
                                            className={`text-left px-2 py-1 rounded ${selectedEntity === 'player' ? 'bg-yellow-900/30 text-yellow-500 border-l-2 border-yellow-500' : 'text-gray-400 hover:bg-gray-800'}`}
                                        >
                                            Player
                                        </button>
                                        <button 
                                            onClick={() => setSelectedEntity('boss')}
                                            className={`text-left px-2 py-1 rounded ${selectedEntity === 'boss' ? 'bg-yellow-900/30 text-yellow-500 border-l-2 border-yellow-500' : 'text-gray-400 hover:bg-gray-800'}`}
                                        >
                                            Boss
                                        </button>
                                    </div>

                                    {/* COL 2: Skill Select */}
                                    <div className="col-span-3 border-r border-gray-700 flex flex-col gap-1 pr-2">
                                        <h4 className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Skill</h4>
                                        {selectedEntity === 'player' ? (
                                            <>
                                                <button 
                                                    onClick={() => setSelectedSkill('atk3')}
                                                    className={`text-left px-2 py-1 rounded ${selectedSkill === 'atk3' ? 'bg-yellow-900/30 text-yellow-500 border-l-2 border-yellow-500' : 'text-gray-400 hover:bg-gray-800'}`}
                                                >
                                                    Attack 3 (Spin)
                                                </button>
                                                <button 
                                                    onClick={() => setSelectedSkill('atk4')}
                                                    className={`text-left px-2 py-1 rounded ${selectedSkill === 'atk4' ? 'bg-yellow-900/30 text-yellow-500 border-l-2 border-yellow-500' : 'text-gray-400 hover:bg-gray-800'}`}
                                                >
                                                    Attack 4 (Fan)
                                                </button>
                                            </>
                                        ) : (
                                            <div className="text-gray-600 italic text-xs px-2">No Configurable Skills</div>
                                        )}
                                    </div>

                                    {/* COL 3: Config */}
                                    <div className="col-span-6 overflow-y-auto max-h-[400px] pr-2">
                                        <h4 className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Configuration</h4>
                                        
                                        {selectedEntity === 'player' && selectedSkill === 'atk3' && (
                                            <div className="flex flex-col gap-4">
                                                {/* Visuals Group */}
                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Visuals</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>Radius</span><span className="text-yellow-500">{debugValues.c3Radius}</span></div>
                                                        <input type="range" min="50" max="200" step="5" value={debugValues.c3Radius} onChange={(e) => updateDebug('c3Radius', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Width</span><span className="text-yellow-500">{debugValues.c3Width}</span></div>
                                                        <input type="range" min="2" max="30" step="1" value={debugValues.c3Width} onChange={(e) => updateDebug('c3Width', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Glow</span><span className="text-yellow-500">{debugValues.c3Glow.toFixed(1)}</span></div>
                                                        <input type="range" min="0" max="2" step="0.1" value={debugValues.c3Glow} onChange={(e) => updateDebug('c3Glow', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Density</span><span className="text-yellow-500">{debugValues.c3Density.toFixed(1)}</span></div>
                                                        <input type="range" min="0" max="1" step="0.1" value={debugValues.c3Density} onChange={(e) => updateDebug('c3Density', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>

                                                {/* Blur Group */}
                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Motion Blur</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>Steps</span><span className="text-yellow-500">{debugValues.c3BlurSteps}</span></div>
                                                        <input type="range" min="0" max="10" step="1" value={debugValues.c3BlurSteps} onChange={(e) => updateDebug('c3BlurSteps', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Blur Fade</span><span className="text-yellow-500">{debugValues.c3BlurFade.toFixed(2)}</span></div>
                                                        <input type="range" min="0" max="0.5" step="0.05" value={debugValues.c3BlurFade} onChange={(e) => updateDebug('c3BlurFade', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>

                                                 {/* Background Group */}
                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Background Disc</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>BG Glow</span><span className="text-yellow-500">{debugValues.c3BgBrightness.toFixed(1)}</span></div>
                                                        <input type="range" min="0" max="1" step="0.1" value={debugValues.c3BgBrightness} onChange={(e) => updateDebug('c3BgBrightness', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>BG Opacity</span><span className="text-yellow-500">{debugValues.c3BgOpacity.toFixed(1)}</span></div>
                                                        <input type="range" min="0" max="1" step="0.1" value={debugValues.c3BgOpacity} onChange={(e) => updateDebug('c3BgOpacity', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>

                                                {/* Logic Group */}
                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Logic / Stats</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>Rotations</span><span className="text-yellow-500">{debugValues.c3Rotations}</span></div>
                                                        <input type="range" min="1" max="5" step="1" value={debugValues.c3Rotations} onChange={(e) => updateDebug('c3Rotations', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>

                                                        <div><div className="flex justify-between"><span>Speed</span><span className="text-yellow-500">{debugValues.c3Speed}</span></div>
                                                        <input type="range" min="5" max="50" step="1" value={debugValues.c3Speed} onChange={(e) => updateDebug('c3Speed', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>

                                                        <div><div className="flex justify-between"><span>Extra Hits</span><span className="text-yellow-500">{debugValues.c3ExtraHits}</span></div>
                                                        <input type="range" min="0" max="10" step="1" value={debugValues.c3ExtraHits} onChange={(e) => updateDebug('c3ExtraHits', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>

                                                        <div><div className="flex justify-between"><span>Total Dmg</span><span className="text-yellow-500">{debugValues.c3TotalDamage}</span></div>
                                                        <input type="range" min="10" max="100" step="5" value={debugValues.c3TotalDamage} onChange={(e) => updateDebug('c3TotalDamage', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>

                                                        <div><div className="flex justify-between"><span>Stun Frames</span><span className="text-yellow-500">{debugValues.c3Stun}</span></div>
                                                        <input type="range" min="0" max="20" step="1" value={debugValues.c3Stun} onChange={(e) => updateDebug('c3Stun', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {selectedEntity === 'player' && selectedSkill === 'atk4' && (
                                             <div className="flex flex-col gap-4">
                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Trails</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>Decay</span><span className="text-yellow-500">{debugValues.trailDecay.toFixed(2)}</span></div>
                                                        <input type="range" min="0.05" max="0.4" step="0.01" value={debugValues.trailDecay} onChange={(e) => updateDebug('trailDecay', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Step (Density)</span><span className="text-yellow-500">{debugValues.trailStep.toFixed(2)}</span></div>
                                                        <input type="range" min="0.01" max="0.3" step="0.01" value={debugValues.trailStep} onChange={(e) => updateDebug('trailStep', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>

                                                <div className="bg-gray-800/30 p-2 rounded border border-gray-800">
                                                    <h5 className="text-yellow-700 font-bold mb-2">Fan Glow</h5>
                                                    <div className="space-y-3">
                                                        <div><div className="flex justify-between"><span>Brightness</span><span className="text-yellow-500">{debugValues.fanBrightness.toFixed(1)}</span></div>
                                                        <input type="range" min="0" max="2.0" step="0.1" value={debugValues.fanBrightness} onChange={(e) => updateDebug('fanBrightness', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                        
                                                        <div><div className="flex justify-between"><span>Opacity</span><span className="text-yellow-500">{debugValues.fanOpacity.toFixed(2)}</span></div>
                                                        <input type="range" min="0" max="1.0" step="0.05" value={debugValues.fanOpacity} onChange={(e) => updateDebug('fanOpacity', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>

                                                        <div><div className="flex justify-between"><span>Fade Speed</span><span className="text-yellow-500">{debugValues.fanFade.toFixed(2)}</span></div>
                                                        <input type="range" min="0.01" max="0.5" step="0.01" value={debugValues.fanFade} onChange={(e) => updateDebug('fanFade', parseFloat(e.target.value))} className="w-full accent-yellow-600" /></div>
                                                    </div>
                                                </div>
                                             </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </>
        )}
    </div>
  );
};

export default GameCanvas;
