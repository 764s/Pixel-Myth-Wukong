
import React, { useRef, useEffect, useCallback } from 'react';
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
const COMBO_3_DAMAGE = 14; // Adjusted for 3 hits (Total ~42 dmg)
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
    // Tempo: 170 BPM (Very fast, driving)
    const TEMPO = 170;
    const SEC_PER_BEAT = 60 / TEMPO;
    const SIXTEENTH = SEC_PER_BEAT / 4;

    // Key: E Minor (Heroic/Rock)
    const E2=82.41, G2=98.00, A2=110.00, B2=123.47;
    const D3=146.83, E3=164.81, G3=196.00, A3=220.00, B3=246.94;
    const D4=293.66, E4=329.63, Fs4=369.99, G4=392.00, A4=440.00, B4=493.88;
    const D5=587.33, E5=659.25;

    // Driving Rock Bass (Sawtooth) - 16 note loop
    const bassLine = [
        E2, E2, E2, G2, E2, E2, A2, B2,  E2, E2, E2, G2, E2, D3, B2, A2
    ];

    // Soaring Melody (Square w/ Vibrato simulation via pitch bends later?)
    // 32-step phrase
    const melodyLine = [
        // Phrase 1
        E4, 0, B3, 0, G3, 0, E3, 0,  E4, 0, D4, 0, B3, 0, A3, G3, 
        A3, 0, B3, 0, D4, 0, E4, 0,  G4, 0, Fs4, 0, D4, 0, B3, 0,
        // Phrase 2 (High)
        E5, 0, 0, 0, B4, 0, 0, 0,    G4, 0, A4, 0, B4, 0, D5, 0,
        E5, 0, D5, 0, B4, 0, A4, 0,  G4, 0, E4, 0, 0, 0, 0, 0
    ];

    const schedule = () => {
        if (!bgmRunningRef.current || !audioCtxRef.current) return;
        
        while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
             const t = nextNoteTimeRef.current;
             const tick = currentTickRef.current;
             
             // 1. Drums (Rock Beat: Kick on 1, 2&, 3. Snare on 2, 4)
             const beatStep = tick % 16;
             // Kick: 0, 4, 7, 10
             if (beatStep === 0 || beatStep === 4 || beatStep === 7 || beatStep === 10) {
                 playOscillator(ctx, 60, t, 0.1, 'triangle', 0.4, 'perc');
             }
             // Snare: 4, 12 (Backbeat)
             if (beatStep === 4 || beatStep === 12) {
                 playNoise(ctx, t, 0.08, 0.15);
             }
             // Hi-hat (every 2)
             if (tick % 2 === 0) {
                 playNoise(ctx, t, 0.01, 0.05);
             }

             // 2. Bass (Driving Sawtooth)
             const bassNote = bassLine[tick % 16];
             if (bassNote) {
                 playOscillator(ctx, bassNote, t, SIXTEENTH * 0.8, 'sawtooth', 0.15, 'pluck');
             }

             // 3. Melody (Lead Square)
             // Melody array is 32 steps long
             const melodyNote = melodyLine[tick % 32];
             if (melodyNote > 0) {
                 // Add simple vibrato effect by detuning slightly?
                 // For 8-bit, just a clean square wave is clearer.
                 // Longer duration for 'pad' like feel on long notes?
                 const isLong = (melodyLine[(tick + 1) % 32] === 0);
                 const dur = isLong ? SIXTEENTH * 2 : SIXTEENTH * 0.9;
                 playOscillator(ctx, melodyNote, t, dur, 'square', 0.08, isLong ? 'pad' : 'pluck');
             }

             // 4. Arp (Magical run) - Every 3rd tick to create polyrhythm feel
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
        // Temporarily disabled BGM
        // startBGM();
    }
  }, [gameState, startBGM]);

  useEffect(() => {
      if (gameState !== GameState.PLAYING) {
          stopBGM();
      }
  }, [gameState, stopBGM]);

  // --- SFX System (FFXIV Style) ---
  const playSound = useCallback((
      type: 
        | 'jump' 
        | 'dash' 
        | 'attack_light' 
        | 'attack_heavy' 
        | 'hit' 
        | 'block' 
        | 'charge' 
        | 'spell' 
        | 'hit_heavy'
        | 'break_spell'
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
              // "Dragoon Jump" - Airy Whoosh + High Chime
              // Noise part
              playNoise(ctx, t, 0.2, 0.1);
              // Tone part
              osc.type = 'sine';
              osc.frequency.setValueAtTime(200, t);
              osc.frequency.linearRampToValueAtTime(800, t + 0.2);
              gain.gain.setValueAtTime(0.1, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.2);
              osc.start(t);
              osc.stop(t + 0.3);
              break;

          case 'dash':
              // "Aetherial Shift" - Sharp White Noise Sweep
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
              // "Weapon Skill" - Sharp Metal + Magic tint
              // Pulse wave swipe
              osc.type = 'square'; 
              osc.frequency.setValueAtTime(880, t);
              osc.frequency.exponentialRampToValueAtTime(110, t + 0.1);
              gain.gain.setValueAtTime(0.08, t);
              gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              osc.start(t);
              osc.stop(t + 0.15);
              break;

           case 'attack_heavy':
              // "Limit Break Start" - Heavy Sawtooth Growl
              osc.type = 'sawtooth';
              osc.frequency.setValueAtTime(220, t);
              osc.frequency.linearRampToValueAtTime(55, t + 0.3);
              gain.gain.setValueAtTime(0.2, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.3);
              osc.start(t);
              osc.stop(t + 0.35);
              break;

          case 'hit':
              // "Crystal Shatter" - Critical Hit Sound
              // Impact
              osc.type = 'triangle';
              osc.frequency.setValueAtTime(150, t);
              osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
              gain.gain.setValueAtTime(0.3, t);
              gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
              osc.start(t);
              osc.stop(t + 0.2);

              // Shatter (High Sine FM)
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
               // Massive Impact (Heavy Attack)
               // 1. Low Thud (Kick-like)
               osc.type = 'triangle';
               osc.frequency.setValueAtTime(100, t);
               osc.frequency.exponentialRampToValueAtTime(20, t + 0.4);
               gain.gain.setValueAtTime(0.8, t);
               gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
               osc.start(t);
               osc.stop(t + 0.5);

               // 2. Bass-heavy Noise Burst
               const nBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
               const nd = nBuf.getChannelData(0);
               for(let i=0; i<nBuf.length; i++) nd[i] = (Math.random() * 2 - 1);
               const nSrc = ctx.createBufferSource();
               nSrc.buffer = nBuf;
               const nFilt = ctx.createBiquadFilter();
               nFilt.type = 'lowpass';
               nFilt.frequency.setValueAtTime(300, t);
               nFilt.frequency.linearRampToValueAtTime(100, t + 0.3);
               nSrc.connect(nFilt);
               nFilt.connect(gain); // Shared gain, or direct? Use new gain for control
               // Creating new gain for noise part to allow independent volume
               const nGain = ctx.createGain();
               nFilt.disconnect();
               nFilt.connect(nGain);
               nGain.connect(ctx.destination);
               nGain.gain.setValueAtTime(0.6, t);
               nGain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
               nSrc.start(t);
               break;

          case 'charge':
              // "Job Gauge Fill" - Rising chime
              osc.type = 'sine';
              osc.frequency.setValueAtTime(440, t);
              osc.frequency.linearRampToValueAtTime(1760, t + 0.3); // 2 octaves up
              
              const tremolo = ctx.createOscillator();
              tremolo.frequency.value = 20; // Fast flutter
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
             // "Immobilize" - Sharp Metallic 'Ding' (Wukong Style)
             const osc1 = ctx.createOscillator();
             osc1.type = 'sine';
             osc1.frequency.setValueAtTime(2500, t); 
             osc1.frequency.exponentialRampToValueAtTime(1000, t + 0.3);
             osc1.connect(gain);
             
             const osc2 = ctx.createOscillator();
             osc2.type = 'triangle';
             osc2.frequency.setValueAtTime(4000, t); // Metallic tint
             osc2.frequency.exponentialRampToValueAtTime(500, t + 0.1);
             osc2.connect(gain);
             
             gain.gain.setValueAtTime(0.4, t);
             gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5); // Long resonant tail
             
             osc1.start(t);
             osc1.stop(t+1.5);
             osc2.start(t);
             osc2.stop(t+1.5);
             break;

          case 'break_spell':
             // REVISED 2: Matching 'spell' tonality (2500/4000Hz) but shattering
             
             // 1. The "Snap" - Sudden pitch drop on the base tone (Matches spell base 2500Hz)
             const snapOsc = ctx.createOscillator();
             snapOsc.type = 'sine';
             snapOsc.frequency.setValueAtTime(2500, t); 
             snapOsc.frequency.exponentialRampToValueAtTime(100, t + 0.1); // Instant snap down
             
             const snapG = ctx.createGain();
             snapG.gain.setValueAtTime(0.5, t);
             snapG.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
             
             snapOsc.connect(snapG);
             snapG.connect(ctx.destination);
             snapOsc.start(t);
             snapOsc.stop(t + 0.15);

             // 2. The "Shards" - High metallic inharmonic ring
             // Uses the same 4000Hz from spell but detuned for dissonance
             const shardOsc = ctx.createOscillator();
             shardOsc.type = 'triangle';
             shardOsc.frequency.setValueAtTime(4000, t); 
             shardOsc.detune.setValueAtTime(500, t); // Discordant
             
             const shardG = ctx.createGain();
             shardG.gain.setValueAtTime(0.3, t);
             shardG.gain.exponentialRampToValueAtTime(0.01, t + 0.2); // Short tail
             
             shardOsc.connect(shardG);
             shardG.connect(ctx.destination);
             shardOsc.start(t);
             shardOsc.stop(t + 0.25);
             
             // 3. Glass Dust - High frequency noise (No low grit)
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
      isDead: false, // Reset dead status to ensure gravity applies
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
      attackCooldown: 60, // Start with a delay
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
    cameraXRef.current = 0;
    shakeRef.current = 0;
    setPlayerHealth(100);
    setBossHealth(1200);
    setStamina(100);
    setScore(0);
    
    if (audioCtxRef.current?.state === 'running') {
        // startBGM(); // Disabled
    }

  }, [setPlayerHealth, setBossHealth, setStamina, setScore, startBGM]);

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
    
    // If entities are frozen in hitstop, usually skip resolution to avoid jitter.
    // BUT, if Boss is immobilized, they should act as a solid wall regardless of hitstop state.
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

      const isAttackPressed = keysRef.current['Space'] || keysRef.current['KeyJ'];
      // Removed KeyK from dodge
      const isDodgePressed = keysRef.current['ShiftLeft'] || keysRef.current['KeyL']; 
      const isSpellPressed = keysRef.current['KeyK'];

      // --- Spell Logic (Immobilize) ---
      if (isSpellPressed && (!player.spellCooldown || player.spellCooldown <= 0) && boss && !boss.isDead) {
           const dist = boss.pos.x - player.pos.x;
           const range = 600; // INCREASED RANGE
           
           // Check facing and range
           const facingTarget = (player.facingRight && dist > 0) || (!player.facingRight && dist < 0);
           
           if (facingTarget && Math.abs(dist) < range) {
               boss.isImmobilized = true;
               boss.immobilizeTimer = 300; // 5 seconds
               boss.immobilizeDamageTaken = 0; // Reset damage tracker
               // NOTE: Do NOT reset boss.state or velocity here. 
               // Immobilize should pause time, not reset state.
               
               playSound('spell');
               
               // Visual: Causality Thread (Player -> Boss)
               // REVISED: Ethereal Arc with scatter
               const pCx = player.pos.x + player.width/2;
               const pCy = player.pos.y + player.height/2;
               const bCx = boss.pos.x + boss.width/2;
               const bCy = boss.pos.y + boss.height/2;
               
               // Control point for a slight arc (visual flair)
               const cX = (pCx + bCx) / 2;
               const cY = (pCy + bCy) / 2 - 40; // Arc upwards slightly
               
               const particleCount = 24;
               for(let i=0; i<=particleCount; i++) {
                   const t = i / particleCount;
                   // Quadratic Bezier: (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
                   const invT = 1 - t;
                   const lx = (invT * invT * pCx) + (2 * invT * t * cX) + (t * t * bCx);
                   const ly = (invT * invT * pCy) + (2 * invT * t * cY) + (t * t * bCy);
                   
                   // "Ethereal" Scatter
                   const scatter = 8; // Pixel variance
                   const offsetX = (Math.random() - 0.5) * scatter;
                   const offsetY = (Math.random() - 0.5) * scatter;

                   particlesRef.current.push({
                       x: lx + offsetX,
                       y: ly + offsetY,
                       vx: (Math.random() - 0.5) * 0.2, // Minimal horizontal drift
                       vy: -Math.random() * 0.5, // Upward float
                       life: 0.4 + Math.random() * 0.3, // Varied short lifespan
                       color: Math.random() > 0.5 ? '#fbbf24' : '#fef3c7', // Gold mixed with pale yellow
                       size: Math.random() * 2 + 0.5 // Varied small sizes
                   });
               }
               
               createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, '#fbbf24', 30, 4);
               // Removed long CD, set small debounce to prevent frame tearing
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

      if ((keysRef.current['ArrowUp'] || keysRef.current['KeyW']) && onGround && !movementLocked && player.state !== 'attack') {
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
      
      if (player.state === 'heavy_attack') activeFrames = player.animFrame >= 2 && player.animFrame <= 6; 
      else if (player.state === 'attack') {
          if (player.comboCount === 1 || player.comboCount === 2) activeFrames = player.animFrame === 1 || player.animFrame === 2;
          // Combo 3 Active Frames adjusted for 3-hit duration (0-12)
          else if (player.comboCount === 3) activeFrames = player.animFrame >= 0 && player.animFrame <= 12; 
          else if (player.comboCount === 4) activeFrames = player.animFrame >= 5 && player.animFrame <= 10; 
      } 
      else if (player.state === 'air_attack') activeFrames = true;

      if (isAttacking && activeFrames && boss && !boss.isDead) {
          let range = ATTACK_RANGE;
          let damage = ATTACK_DAMAGE;
          let isAir = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);
          // Multi-hit applies to Air Attack AND Attack 3 (Combo Count 3)
          let isMultiHit = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);

          if (player.state === 'heavy_attack') {
              range = HEAVY_ATTACK_RANGE;
              damage = HEAVY_ATTACK_DAMAGE;
          } else if (isAir) {
              damage = (player.state === 'attack' && player.comboCount === 3) ? COMBO_3_DAMAGE : AIR_ATTACK_DAMAGE;
              // Combo 3: Adjusted range to match visual spin (approx 1.5x)
              range = (player.state === 'attack' && player.comboCount === 3) ? ATTACK_RANGE * 1.5 : ATTACK_RANGE * 1.5;
          } else if (player.state === 'attack') {
              if (player.comboCount === 2) { damage = COMBO_2_DAMAGE; range = ATTACK_RANGE * 1.2; }
              if (player.comboCount === 4) {
                  damage = COMBO_4_SLAM_DAMAGE;
                  range = ATTACK_RANGE * 2.0;
              }
          }
          
          const pCx = player.pos.x + player.width/2;
          const pCy = player.pos.y + player.height/2;
          const bCx = boss.pos.x + boss.width/2;
          const bCy = boss.pos.y + boss.height/2;
          
          let hit = false;
          
          if (isAir) {
              const dist = Math.sqrt(Math.pow(pCx - bCx, 2) + Math.pow(pCy - bCy, 2));
              if (dist < range) hit = true;
          } else {
              let attackBoxX = player.facingRight ? player.pos.x + player.width : player.pos.x - range;
              let attackBoxW = range;
              let attackBoxY = player.pos.y;
              let attackBoxH = player.height;

              if ((player.state === 'attack' && player.comboCount === 4) || player.state === 'heavy_attack') {
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

          if (hit) {
              if (isAir || player.state === 'air_attack') {
                  player.hasHitInAir = true;
              }

              let shouldRegisterHit = false;
              if (isMultiHit) {
                   if (player.attackCooldown <= 0) {
                       shouldRegisterHit = true;
                   }
              } else {
                   if (!player.hasDealtDamage) {
                       shouldRegisterHit = true;
                   }
              }

              if (shouldRegisterHit) { 
                 boss.health -= damage;
                 const isHeavyHit = player.state === 'heavy_attack' || player.comboCount === 4;

                 // Immobilized Boss Logic on Hit
                 if (boss.isImmobilized) {
                    // Accumulate damage to break spell
                    boss.immobilizeDamageTaken = (boss.immobilizeDamageTaken || 0) + damage;

                    if (boss.immobilizeDamageTaken > IMMOBILIZE_BREAK_THRESHOLD) {
                        // BREAK!
                        boss.isImmobilized = false;
                        boss.immobilizeDamageTaken = 0;
                        boss.immobilizeTimer = 0;

                        // 1. Visuals & Sound
                        playSound('break_spell'); // High pitch shatter
                        shakeRef.current = 25; // Heavy Shake (Guaranteed and Increased)
                        
                        // 2. Particles (Explosion of Gold & Glass)
                        for(let i=0; i<25; i++) {
                            // Gold Shards
                            particlesRef.current.push({
                                x: boss.pos.x + boss.width/2,
                                y: boss.pos.y + boss.height/2,
                                vx: (Math.random() - 0.5) * 18,
                                vy: (Math.random() - 0.5) * 18,
                                life: 1.2,
                                color: '#fbbf24',
                                size: Math.random() * 4 + 3
                            });
                            // White Glass Shards
                            particlesRef.current.push({
                                x: boss.pos.x + boss.width/2,
                                y: boss.pos.y + boss.height/2,
                                vx: (Math.random() - 0.5) * 15,
                                vy: (Math.random() - 0.5) * 15,
                                life: 1.0,
                                color: '#ffffff',
                                size: Math.random() * 3 + 2
                            });
                        }

                        // 3. Recoil/Hit State Force
                        boss.state = 'hit';
                        boss.animFrame = 0;
                        boss.vx = player.facingRight ? 8 : -8; // Knockback applied on break

                        // 4. Hit Stop Calculation
                        let stopDuration = 10;
                        if (isHeavyHit) stopDuration = 15;
                        else if (isMultiHit) stopDuration = 8;
                        
                        // NEW: Ensure minimum hitstop for break is at least 18 frames
                        const finalStun = Math.max(stopDuration, 18);

                        player.hitStop = finalStun;
                        boss.hitStop = finalStun;

                    } else {
                        // Hit while frozen, but didn't break
                        playSound(isHeavyHit ? 'hit_heavy' : 'hit');
                        shakeRef.current = 5;
                        createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, '#fbbf24', 8, 5);
                        
                        // Small hitstop to feel the impact on the frozen body
                        player.hitStop = 3;
                        boss.hitStop = 3;
                    }
                 } else {
                     // Normal Hit Logic
                     // REVISED KNOCKBACK: Only Combo 4 (Finisher) and Heavy Attack deal knockback.
                     let kForce = 0; 
                     if (player.comboCount === 4) kForce = 8; // Reduced from 15 to 8 (Medium push)
                     if (player.state === 'heavy_attack') kForce = 12; // Reduced from 25 to 12 (Hard push)
                     
                     boss.vx = player.facingRight ? kForce : -kForce;
                     boss.state = 'hit';
                     boss.animTimer = 0;
                     
                     let stopDuration = 10; 
                     let shakeInt = 5;

                     if (player.state === 'heavy_attack' || player.comboCount === 4) {
                         stopDuration = 15; 
                         shakeInt = 20;
                         createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height, '#fff', 20, 15);
                     } else if (isMultiHit) {
                         // Multi-Hit Logic (Air or Combo 3)
                         if (player.comboCount === 3) {
                             // Combo 3 Spin: Snappy but visible hits
                             stopDuration = 8; // Increased from 6 to 8 for better weight
                             shakeInt = 2; // Added slight shake
                         } else {
                             // Air Attack: Keep original feel
                             stopDuration = 8; 
                             shakeInt = 5;
                         }
                     } else if (player.comboCount === 1 || player.comboCount === 2) {
                         // Increased hitstop for light attacks to improve feel
                         stopDuration = 4; 
                     }

                     player.hitStop = stopDuration; 
                     // Sync boss hitstop
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
                         // HIT FREQUENCY LOGIC FOR 3 HITS in 12 frames (1 turn):
                         // Hits at frames 0, 6, 12 (every 6 frames)
                         // Cooldown 11 ticks (since update speed 1 = 2 ticks/frame -> 6 frames = 12 ticks)
                         player.attackCooldown = 11;
                     } else {
                         // Standard Air Attack cooldown
                         player.attackCooldown = 18; 
                     }
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
           // Combo 3 duration set to 12 to ensure 3-hit sequence fits naturally (1 rotation)
           const limit = player.comboCount === 3 ? 12 : 18; 
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
          if (player.comboCount === 3) animSpeed = 1; // Fastest spin (2 ticks per frame)
          else if (player.comboCount === 4) animSpeed = 1; 
          else animSpeed = 3; // Faster light attack
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
      // Allow hitStop to decrement even if immobilized, ensuring collision flags clear
      if (boss.hitStop > 0) boss.hitStop--;

      if (boss.isImmobilized) {
          // FROZEN STATE (Immobilize)
          // Timer Tick Down
          if (boss.immobilizeTimer && boss.immobilizeTimer > 0) {
             boss.immobilizeTimer--;
             
             // Golden Particles emission
             const flickerRate = 10;
             if (boss.immobilizeTimer % flickerRate === 0) {
                 createParticles(boss.pos.x + Math.random()*boss.width, boss.pos.y + Math.random()*boss.height, '#fbbf24', 1, 1);
             }
          } else {
             // Time expired naturally
             boss.isImmobilized = false;
          }
      } else {
        // NORMAL STATE (Physics & Logic Active)
        
        // If not in hitstop (visual freeze), run AI
        if (boss.hitStop <= 0) {
            boss.facingRight = player.pos.x > boss.pos.x;
            const distance = Math.abs(player.pos.x - boss.pos.x);
            const PREFERRED_DISTANCE = 220;
            
            // --- DEBUG: FORCE KOWTOW ATTACK ---
            // If not busy with another high-priority state, check cooldown and force kowtow.
            const isBusy = ['attack', 'jump_smash', 'hit', 'kowtow_attack'].includes(boss.state);
            if (!isBusy) {
                 if (boss.attackCooldown <= 0) {
                      boss.state = 'kowtow_attack';
                      boss.animFrame = 0;
                      boss.animTimer = 0;
                      boss.vx = 0; // Stop movement for the attack
                 }
            }

            if (boss.state === 'kowtow_attack') {
                // KOWTOW ATTACK LOGIC
                // Frames 0-3: Windup (Lean back)
                // Frame 4: Slam Impact
                // Frames 5-12: Recovery (Head stuck/Get up)
                
                const IMPACT_FRAME = 4;
                
                if (boss.animFrame === IMPACT_FRAME && boss.animTimer === 0) { 
                     // Trigger ONCE when entering frame 4
                     playSound('hit_heavy');
                     shakeRef.current = 15;
                     
                     // Visuals: Shockwave
                     // Calculate head position based on facing
                     const headX = boss.facingRight ? boss.pos.x + boss.width + 40 : boss.pos.x - 40;
                     const headY = GROUND_Y;
                     
                     // Central puff
                     createParticles(headX, headY, '#a855f7', 8, 12); // Purple impact core
                     createParticles(headX, headY, '#ffffff', 8, 8); // Dust core
                     
                     // New Visuals: Shockwave Hint (Low Presence, Range Diffusion)
                     // Calculate speed to reach 150px in approx 20 frames (particle life)
                     const shockwaveRange = 150;
                     const particleLifeFrames = 20;
                     const swSpeed = shockwaveRange / particleLifeFrames; 
                     
                     // ENHANCED PARTICLE LOOP
                     for(let i=0; i<12; i++) { // Increased from 8
                         // Right Wave
                         particlesRef.current.push({
                             x: headX, 
                             y: headY - 2,
                             vx: swSpeed * (0.8 + Math.random() * 0.4), // Varied speed for spread
                             vy: (Math.random() - 0.5) * 2 - 1, // Slight kick up
                             life: 1.0,
                             color: i % 2 === 0 ? 'rgba(120, 113, 108, 0.8)' : 'rgba(168, 162, 158, 0.5)', // Darker stone vs Light dust
                             size: 2 + Math.random() * 4 // Larger variance
                         });
                         // Left Wave
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
                     
                     // Hit Detection (AOE)
                     const range = shockwaveRange; // Match visual
                     const dist = Math.abs((player.pos.x + player.width/2) - headX);
                     const vertDist = Math.abs((player.pos.y + player.height) - headY);
                     
                     // Must be on ground or close to it, and within range
                     if (dist < range && vertDist < 40 && player.state !== 'dodge') {
                          player.health -= BOSS_KOWTOW_DAMAGE;
                          player.state = 'hit';
                          player.hitStop = 15;
                          player.vy = -10; // Pop up
                          player.vx = boss.facingRight ? 8 : -8; // Knockback
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
                    boss.attackCooldown = 60; // Wait 1 second before next attack (Debug purpose)
                }
            }
            else if (boss.state !== 'hit') {
                // Standard AI (Lower priority than debug loop above, so kowtow will likely override)
                // Keeping basic movement logic so boss doesn't freeze between kowtows
                
                if (boss.state === 'run' && distance < 250 && distance > 100 && Math.random() < 0.02 && boss.attackCooldown <= 0) {
                    // Suppressed by debug logic mostly, but harmless to keep
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
                            player.health -= BOSS_DAMAGE * 1.5;
                            player.vx = boss.facingRight ? 15 : -15;
                            player.vy = -5;
                            player.state = 'hit';
                            player.hitStop = 12; 
                            boss.hitStop = 8; 
                            setPlayerHealth(player.health);
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
            } else if (boss.state === 'hit') {
                boss.vx *= 0.9;
                if (Math.abs(boss.vx) < 0.1) boss.state = 'idle';
                if (boss.state === 'hit' && boss.animTimer > 20) {
                    boss.state = 'idle';
                }
            }
        } // End AI checks (if !hitStop)
        
        if (boss.attackCooldown > 0) boss.attackCooldown--;
        boss.vy += GRAVITY;
        boss.pos.x += boss.vx;
        boss.pos.y += boss.vy;
        
        if (boss.pos.y + boss.height > GROUND_Y) {
            boss.pos.y = GROUND_Y - boss.height;
            boss.vy = 0;
        }
        boss.pos.x = Math.max(0, Math.min(boss.pos.x, 1200 - boss.width));

        // Boss Animation Update
        // Skip animation update during hitStop (freeze frame effect)
        if (boss.hitStop <= 0) {
            let bossAnimSpeed = 10;
            if (boss.state === 'kowtow_attack') bossAnimSpeed = 6; // Slower animation for weight
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
        boss.isDead = true;
        setGameState(GameState.VICTORY);
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

  const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;
  const easeOutQuad = (t: number) => t * (2 - t);
  const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

  const getAnimSpeed = (p: Entity) => {
      if (p.state === 'run') return 5;
      if (p.state === 'attack') {
          if (p.comboCount === 3) return 1; // UPDATED HERE
          if (p.comboCount === 4) return 1;
          return 3; // Faster default attack speed (was 5)
      }
      if (p.state === 'heavy_attack') return 2;
      if (p.state === 'dodge') return 3;
      if (p.state === 'hit') return 10;
      if (p.state === 'air_attack') return 2;
      return 8;
  };

  const drawPlayer = (ctx: CanvasRenderingContext2D, p: Entity) => {
    const { width: w, height: h, state, animFrame, comboCount, hitStop } = p;
    
    const speed = getAnimSpeed(p);
    // Using just division as speed is guaranteed to be >= 1 by getAnimSpeed logic
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
            // Rotate continuously based on frame count
            // REVISED for 3 hits in 360 degrees over 12 frames
            const angle = (smoothFrame / 12) * (Math.PI * 2);

            ctx.translate(0, -35); 
            
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = cGold;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            // Increased visual radius to 100
            ctx.arc(0, 0, 100, angle - 1.5, angle, false);
            ctx.arc(0, 0, 85, angle, angle - 1.5, true);
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.globalCompositeOperation = 'source-over';

            ctx.save();
            ctx.rotate(angle); 
            
            ctx.globalCompositeOperation = 'lighter';
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 30; 
            
            ctx.fillStyle = cGold;
            ctx.beginPath();
            ctx.arc(0, 0, 90, 0, Math.PI*2);
            ctx.fill();
            
            ctx.shadowBlur = 0;
            ctx.globalCompositeOperation = 'source-over';

            // Increased cross/staff visual size
            drawRect(ctx, -100, -4, 200, 8, cStaff);
            drawRect(ctx, -4, -100, 8, 200, cGold);
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
            
            let angle = 0;
            const startAngle = -2.5; 
            const endAngle = 1.8; 
            
            if (t <= 5) {
                const heave = Math.sin(t * 0.5) * 0.1;
                angle = startAngle + heave;
            } 
            else if (t <= 10) {
                 const progress = (t - 5) / 5;
                 const ease = progress * progress; 
                 angle = lerp(startAngle, endAngle, ease);
                 
                 ctx.globalCompositeOperation = 'lighter';
                 ctx.fillStyle = cGold;
                 ctx.globalAlpha = 0.8;
                 ctx.beginPath();
                 ctx.moveTo(0,0);
                 ctx.arc(0,0, 160, angle - 0.6, angle, true);
                 ctx.lineTo(0,0);
                 ctx.fill();
                 ctx.globalCompositeOperation = 'source-over';
                 ctx.globalAlpha = 1.0;
            }
            else {
                 angle = endAngle;
                 if (t < 14) angle += (Math.random()-0.5)*0.1; 
            }

            ctx.rotate(angle);
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 40;
            drawRect(ctx, -10, -5, 150, 12, cGold); 
            drawRect(ctx, 140, -8, 20, 18, '#fff'); 
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
        // Immobilize prevents shaking hit stun
        if (b.state === 'hit' && b.hitStop > 0 && !b.isImmobilized) {
            bossShakeX = (Math.random() - 0.5) * 6;
            bossShakeY = (Math.random() - 0.5) * 6;
        }

        ctx.save();
        ctx.translate(bossShakeX, bossShakeY);
        
        // Kowtow Rotation Transform
        if (b.state === 'kowtow_attack') {
             const originX = bx + b.width / 2;
             const originY = by + b.height;
             ctx.translate(originX, originY);
             
             // Determine rotation direction based on facing
             const dir = b.facingRight ? 1 : -1;
             
             let angle = 0;
             const frame = b.animFrame;
             
             // 0-3: Windup (Lean back away from target)
             if (frame <= 3) {
                 angle = lerp(0, -0.4 * dir, frame/3);
             } 
             // 4: Slam (Fast forward)
             else if (frame === 4) {
                 angle = 1.6 * dir; // ~90 degrees forward
             }
             // 5+: Recovery
             else {
                 // Slowly rise
                 angle = lerp(1.6 * dir, 0, (frame - 5)/7);
             }
             
             ctx.rotate(angle);
             ctx.translate(-originX, -originY);
        }

        // Reduced Flash: Flicker 2-3 times during impact to avoid blinding "white screen"
        // Only active during hitStop (freeze frames), creating a strobe effect.
        const isFlashing = b.state === 'hit' && 
                           !b.isImmobilized && 
                           b.hitStop > 0 && 
                           (b.hitStop % 5 > 2); 

        if (isFlashing) {
             ctx.fillStyle = '#fff'; 
             ctx.fillRect(bx, by, b.width, b.height);
        } else {
            // Boss Color Logic
            let bColor = b.state === 'jump_smash' ? '#7e22ce' : '#581c87';
            let bAccent = '#3b0764';
            
            // Gold tint if immobilized
            if (b.isImmobilized) {
                bColor = '#fbbf24'; // Gold
                bAccent = '#d97706'; // Darker Gold
                
                // Add glow
                ctx.shadowColor = '#fbbf24';
                ctx.shadowBlur = 15;
            }
            
            drawRect(ctx, bx, by, b.width, b.height, bColor); 
            drawRect(ctx, bx - 10, by + 10, 20, 60, bAccent); 
            drawRect(ctx, bx + b.width - 10, by + 10, 20, 60, bAccent);
            
            ctx.shadowBlur = 0;
            
            // Eye/Details
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

      // Safety cap to prevent spiral of death on lag spikes
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

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      className="w-full h-full object-contain bg-neutral-900 shadow-2xl"
    />
  );
};

export default GameCanvas;
