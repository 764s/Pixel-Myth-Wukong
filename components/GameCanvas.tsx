
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
const COMBO_3_DAMAGE = 30; // Single hit, higher damage
const COMBO_4_SLAM_DAMAGE = 45; // Main slam damage
const HEAVY_ATTACK_DAMAGE = 60;
const HEAVY_ATTACK_RANGE = 300; 
const AIR_ATTACK_DAMAGE = 8; // Lower damage per tick for multi-hit

const DODGE_SPEED = 18; 
const DODGE_COOLDOWN = 40;
const DODGE_STAMINA_COST = 20;

const BOSS_DAMAGE = 15;
const CHARGE_THRESHOLD = 20; 
const COMBO_WINDOW_FRAMES = 50; 

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
  
  // BGM Refs
  const bgmRunningRef = useRef<boolean>(false);
  const nextNoteTimeRef = useRef<number>(0);
  const schedulerTimerRef = useRef<number>(0);
  const melodyIndexRef = useRef<number>(0);

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
    hitStop: 0
  });

  const bossRef = useRef<Entity | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const keysRef = useRef<{ [key: string]: boolean }>({});
  const cameraXRef = useRef(0);
  const shakeRef = useRef(0);

  // --- BGM System ---
  const stopBGM = useCallback(() => {
    bgmRunningRef.current = false;
    if (schedulerTimerRef.current) {
        cancelAnimationFrame(schedulerTimerRef.current);
        schedulerTimerRef.current = 0;
    }
  }, []);

  const playBGMNote = (ctx: AudioContext, freq: number, time: number, duration: number, type: 'melody' | 'bass') => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    if (type === 'bass') {
        // Gritty Bass: Sawtooth with Lowpass Filter
        osc.type = 'sawtooth';
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(150, time); // Deep
        filter.frequency.linearRampToValueAtTime(100, time + duration);
        osc.connect(filter);
        filter.connect(gain);
    } else {
        // Melody: Sharp Square (Plucked)
        osc.type = 'square';
        osc.connect(gain);
    }

    gain.connect(ctx.destination);
    
    // Envelope
    if (type === 'melody') {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.08, time + 0.02); // Fast attack
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration); // Pluck decay
    } else {
        // Bass Driving Pulse
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.15, time + 0.05);
        gain.gain.linearRampToValueAtTime(0, time + duration);
    }

    osc.start(time);
    osc.stop(time + duration + 0.1);
  };

  const startBGM = useCallback(() => {
    if (bgmRunningRef.current || !audioCtxRef.current) return;
    
    const ctx = audioCtxRef.current;
    bgmRunningRef.current = true;
    nextNoteTimeRef.current = ctx.currentTime + 0.1;
    melodyIndexRef.current = 0;

    // "Moonlit Duel" Theme
    // Tempo: Fast ~150 BPM.
    // Scale: Phrygian Dominant (E F G# A B C D) - Dark, Mythic, Eastern
    const SIXTH = 0.10; // 16th note duration approx

    // Frequencies
    const E2 = 82.41, F2 = 87.31, Gs2 = 103.83, A2 = 110.00, B2 = 123.47;
    const E3 = 164.81, F3 = 174.61, Gs3 = 207.65, A3 = 220.00, B3 = 246.94, C4 = 261.63, D4 = 293.66, E4 = 329.63;

    const melody = [
        // Phrase 1: The Driving Riff (E Phrygian)
        { f: E3, d: SIXTH }, { f: E3, d: SIXTH }, { f: B3, d: SIXTH }, { f: E3, d: SIXTH },
        { f: C4, d: SIXTH }, { f: B3, d: SIXTH }, { f: A3, d: SIXTH }, { f: Gs3, d: SIXTH },
        
        { f: E3, d: SIXTH }, { f: E3, d: SIXTH }, { f: D4, d: SIXTH }, { f: E3, d: SIXTH }, 
        { f: F3, d: SIXTH }, { f: E3, d: SIXTH }, { f: D4, d: SIXTH }, { f: B3, d: SIXTH },

        // Phrase 2: Tension
        { f: E3, d: SIXTH }, { f: E3, d: SIXTH }, { f: E4, d: SIXTH }, { f: B3, d: SIXTH },
        { f: D4, d: SIXTH }, { f: C4, d: SIXTH }, { f: B3, d: SIXTH }, { f: A3, d: SIXTH },

        { f: Gs3, d: SIXTH * 2 }, { f: F3, d: SIXTH * 2 }, { f: E3, d: SIXTH * 4 }, // Resolve

        // Phrase 3: High Variation
        { f: B3, d: SIXTH }, { f: C4, d: SIXTH }, { f: D4, d: SIXTH }, { f: E4, d: SIXTH },
        { f: F3, d: SIXTH * 2 }, { f: E4, d: SIXTH * 2 },
        { f: D4, d: SIXTH }, { f: C4, d: SIXTH }, { f: B3, d: SIXTH }, { f: A3, d: SIXTH },
        { f: Gs3, d: SIXTH * 4 }
    ];

    const schedule = () => {
        if (!bgmRunningRef.current || !audioCtxRef.current) return;
        
        // Lookahead: Schedule notes
        while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
             const note = melody[melodyIndexRef.current];
             
             // Melody
             if (note.f > 0) {
                playBGMNote(audioCtxRef.current, note.f, nextNoteTimeRef.current, note.d, 'melody');
             }

             // Driving Bass (Pulse on beats)
             if (melodyIndexRef.current % 4 === 0) {
                 playBGMNote(audioCtxRef.current, E2, nextNoteTimeRef.current, SIXTH, 'bass');
             }
             // Syncopated Bass
             if (melodyIndexRef.current % 8 === 6) {
                 playBGMNote(audioCtxRef.current, B2, nextNoteTimeRef.current, SIXTH, 'bass');
             }
             
             nextNoteTimeRef.current += note.d;
             melodyIndexRef.current = (melodyIndexRef.current + 1) % melody.length;
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
    // Start BGM if playing
    if (gameState === GameState.PLAYING && !bgmRunningRef.current) {
        startBGM();
    }
  }, [gameState, startBGM]);

  // Stop BGM when not playing
  useEffect(() => {
      if (gameState !== GameState.PLAYING) {
          stopBGM();
      }
  }, [gameState, stopBGM]);


  const playSound = useCallback((type: 'jump' | 'dash' | 'attack_light' | 'attack_heavy' | 'hit' | 'block' | 'charge') => {
      if (!audioCtxRef.current) return;
      const ctx = audioCtxRef.current;
      const t = ctx.currentTime;

      // Helper: Create White Noise Buffer
      const createNoiseBuffer = () => {
          const bufferSize = ctx.sampleRate * 0.5; 
          const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
              data[i] = Math.random() * 2 - 1;
          }
          return buffer;
      };

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      switch (type) {
          case 'jump':
              // Snappy slide up
              osc.type = 'square';
              osc.frequency.setValueAtTime(100, t);
              osc.frequency.exponentialRampToValueAtTime(350, t + 0.1);
              gain.gain.setValueAtTime(0.08, t);
              gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              osc.start(t);
              osc.stop(t + 0.1);
              break;
          case 'dash':
              // High-pass filtered noise (Airy Whoosh)
              const noiseDash = ctx.createBufferSource();
              noiseDash.buffer = createNoiseBuffer();
              const dashFilter = ctx.createBiquadFilter();
              dashFilter.type = 'highpass';
              dashFilter.frequency.setValueAtTime(800, t);
              const dashGain = ctx.createGain();
              
              noiseDash.connect(dashFilter);
              dashFilter.connect(dashGain);
              dashGain.connect(ctx.destination);
              
              dashGain.gain.setValueAtTime(0.3, t);
              dashGain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
              noiseDash.start(t);
              noiseDash.stop(t + 0.15);
              break;
          case 'attack_light':
              // Filtered Sawtooth Sweep (Sharp Sword Sound)
              osc.type = 'sawtooth';
              const attFilter = ctx.createBiquadFilter();
              attFilter.type = 'lowpass';
              attFilter.frequency.setValueAtTime(2000, t);
              attFilter.frequency.exponentialRampToValueAtTime(100, t + 0.1);
              
              osc.disconnect();
              osc.connect(attFilter);
              attFilter.connect(gain);
              
              osc.frequency.setValueAtTime(300, t); // Lower base pitch
              osc.frequency.exponentialRampToValueAtTime(50, t + 0.1);
              
              gain.gain.setValueAtTime(0.15, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.1);
              osc.start(t);
              osc.stop(t + 0.1);
              break;
           case 'attack_heavy':
              // Deep Charge Sweep
              osc.type = 'sawtooth';
              osc.frequency.setValueAtTime(100, t);
              osc.frequency.exponentialRampToValueAtTime(600, t + 0.3); // Pitch up
              
              gain.gain.setValueAtTime(0.2, t);
              gain.gain.linearRampToValueAtTime(0, t + 0.3);
              osc.start(t);
              osc.stop(t + 0.3);
              break;
          case 'hit':
              // Crunch (Noise) + Punch (Sine Drop)
              const hitNoise = ctx.createBufferSource();
              hitNoise.buffer = createNoiseBuffer();
              const hitFilter = ctx.createBiquadFilter();
              hitFilter.type = 'lowpass';
              hitFilter.frequency.setValueAtTime(1000, t);
              const hitGain = ctx.createGain();
              
              hitNoise.connect(hitFilter);
              hitFilter.connect(hitGain);
              hitGain.connect(ctx.destination);
              
              hitGain.gain.setValueAtTime(0.5, t);
              hitGain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              hitNoise.start(t);
              hitNoise.stop(t + 0.1);
              
              // Punch
              const punchOsc = ctx.createOscillator();
              const punchGain = ctx.createGain();
              punchOsc.type = 'square';
              punchOsc.frequency.setValueAtTime(150, t);
              punchOsc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
              punchGain.gain.setValueAtTime(0.3, t);
              punchGain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
              punchOsc.connect(punchGain);
              punchGain.connect(ctx.destination);
              punchOsc.start(t);
              punchOsc.stop(t + 0.1);
              break;
          case 'charge':
              // Magical Tremolo
              const magicOsc = ctx.createOscillator();
              const magicGain = ctx.createGain();
              magicOsc.connect(magicGain);
              magicGain.connect(ctx.destination);
              magicOsc.type = 'triangle';
              
              magicOsc.frequency.setValueAtTime(200, t);
              magicOsc.frequency.linearRampToValueAtTime(800, t + 0.2);
              
              magicGain.gain.setValueAtTime(0.05, t);
              magicGain.gain.linearRampToValueAtTime(0.15, t + 0.1);
              magicGain.gain.linearRampToValueAtTime(0, t + 0.2);
              
              magicOsc.start(t);
              magicOsc.stop(t + 0.2);
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
      animFrame: 0,
      animTimer: 0,
      attackCooldown: 0,
      dodgeCooldown: 0,
      chargeTimer: 0,
      comboCount: 0,
      comboWindow: 0,
      hasHitInAir: false,
      hasDealtDamage: false,
      hitStop: 0
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
      attackCooldown: 100,
      dodgeCooldown: 0,
      chargeTimer: 0,
      comboCount: 0,
      comboWindow: 0,
      animFrame: 0,
      animTimer: 0,
      hitStop: 0
    };

    particlesRef.current = [];
    cameraXRef.current = 0;
    shakeRef.current = 0;
    setPlayerHealth(100);
    setBossHealth(1200);
    setStamina(100);
    setScore(0);
    
    // Attempt to start BGM if context is ready
    if (audioCtxRef.current?.state === 'running') {
        startBGM();
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
    // Collision Physics should NOT apply during hitstop freeze to prevent weird sliding
    if (e1.hitStop > 0 || e2.hitStop > 0) return; 

    if (e1.pos.x < e2.pos.x + e2.width &&
        e1.pos.x + e1.width > e2.pos.x &&
        e1.pos.y < e2.pos.y + e2.height &&
        e1.pos.y + e1.height > e2.pos.y) {
        
        const center1 = e1.pos.x + e1.width / 2;
        const center2 = e2.pos.x + e2.width / 2;
        const pushForce = 2; 

        if (center1 < center2) {
            e1.pos.x -= pushForce;
            if (e2.type === 'boss') {
                e2.vx = 0;
            } else {
                e2.pos.x += pushForce;
            }
            if (e1.vx > 0) e1.vx = 0;
        } else {
            e1.pos.x += pushForce;
            if (e2.type === 'boss') {
                e2.vx = 0;
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

    // Screen Shake Decay (Always runs on Global Timeline)
    if (shakeRef.current > 0) shakeRef.current *= 0.9;
    if (shakeRef.current < 0.5) shakeRef.current = 0;

    const player = playerRef.current;
    const boss = bossRef.current;

    // --- 1. Player Logic ---
    // Strict Local Timeline: If hitStop > 0, time is PAUSED for this entity.
    if (player.hitStop > 0) {
        player.hitStop--;
        // SKIP all physics, inputs, animation, and cooldowns
    } else if (!player.isDead) {
      // --- Active Timeline Starts ---
      const onGround = player.pos.y + player.height >= GROUND_Y;
      
      // Cooldowns Management
      if (player.attackCooldown > 0) player.attackCooldown--;
      if (player.dodgeCooldown > 0) player.dodgeCooldown--;
      if (player.comboWindow > 0) player.comboWindow--;
      
      if (player.comboWindow === 0 && player.state !== 'attack') {
          player.comboCount = 0;
      }

      const isAttackPressed = keysRef.current['Space'] || keysRef.current['KeyJ'];
      const isDodgePressed = keysRef.current['ShiftLeft'] || keysRef.current['KeyK'] || keysRef.current['KeyL'];
      
      // DODGE
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
        
        // CHARGING
        if (isAttackPressed) {
           // Ensure we can charge during air_attack to buffer the next input
           if (player.state !== 'attack' && player.state !== 'heavy_attack') {
             player.chargeTimer++;
             if (player.chargeTimer % 8 === 0) playSound('charge'); 
             if (player.chargeTimer > CHARGE_THRESHOLD && player.chargeTimer % 5 === 0) {
                createParticles(player.pos.x + player.width/2, player.pos.y + player.height/2, '#fbbf24', 1, 2);
             }
           }
        }
        // ATTACK TRIGGER
        else if (!isAttackPressed && player.chargeTimer > 0) {
            if (player.chargeTimer > CHARGE_THRESHOLD) {
                // HEAVY ATTACK
                player.state = 'heavy_attack';
                player.attackCooldown = 30;
                player.animFrame = 0;
                player.vx = player.facingRight ? 12 : -12; 
                player.comboCount = 0; 
                player.hasDealtDamage = false; // Reset single hit flag
                setStamina(0);
                playSound('attack_heavy');
            } 
            else {
                const isAlreadyAttacking = player.state === 'attack' || player.state === 'heavy_attack' || player.state === 'air_attack';
                const isCurrentlyAirAttack = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);
                
                let allowAttack = true;
                if (!onGround && isCurrentlyAirAttack) {
                    if (player.state === 'air_attack') {
                        // Allow Cancel into Slam (Combo 4) ANYTIME
                        allowAttack = true;
                    } else {
                        // Check legacy air hit flag (if chained from a different logic)
                        if (!player.hasHitInAir) allowAttack = false;
                        else player.hasHitInAir = false; // Consume the flag
                    }
                }

                if (!isAlreadyAttacking || allowAttack) {
                   player.hasDealtDamage = false; // Reset single hit flag for new attack

                   if (onGround) {
                       player.state = 'attack';
                       if (player.comboWindow > 0) {
                           player.comboCount = (player.comboCount % 4) + 1;
                       } else {
                           player.comboCount = 1;
                       }
                       
                       // Ground Attack Logic
                       if (player.comboCount === 3) {
                           // Launcher - Lower Jump
                           player.vy = -6.5; 
                       }
                       if (player.comboCount === 4) {
                           player.vy = -5; 
                           // Single stage animation duration
                           player.attackCooldown = 30; 
                       }
                       
                       let lunge = 3;
                       if (player.comboCount === 2) lunge = 6;
                       if (player.comboCount === 3) lunge = 4;
                       if (player.comboCount === 4) lunge = 2;

                       player.vx = player.facingRight ? lunge : -lunge;
                       playSound('attack_light');
                   } else {
                       // Aerial Logic
                       // Allow chaining Combo 3 (Launcher) or Air Attack into Combo 4 (Slam)
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
                           // Height Check: Avoid triggering spin if too close to ground
                           const distToGround = GROUND_Y - (player.pos.y + player.height);
                           if (distToGround > 50) { // Only air spin if we have height
                                player.state = 'air_attack';
                                player.comboCount = 0; 
                                player.vy = -4;
                                player.attackCooldown = 15;
                                playSound('attack_light');
                           } else {
                                // If too low, ignore
                                player.chargeTimer = 0;
                                return; 
                           }
                       }
                   }
                   
                   if (player.attackCooldown === 0) player.attackCooldown = 15; 
                   // Ensure Combo 3 duration is enough for animation (6 frames * 3 speed = 18 ticks)
                   if (player.comboCount === 3) player.attackCooldown = 20; 

                   player.animFrame = 0;
                }
            }
            player.chargeTimer = 0;
        }
      } else {
          if (!isAttackPressed) player.chargeTimer = 0;
      }

      // --- Physics: Movement ---
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

      // Normal Jump
      if ((keysRef.current['ArrowUp'] || keysRef.current['KeyW']) && onGround && !movementLocked && player.state !== 'attack') {
        player.vy = JUMP_FORCE;
        playSound('jump');
        createParticles(player.pos.x + player.width/2, player.pos.y + player.height, '#78350f', 5); 
      }

      if (player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3)) {
         player.vy += GRAVITY * 0.25; // Float during spin
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

      // --- Combat Hitbox Logic ---
      const isAttacking = (player.state === 'attack' || player.state === 'heavy_attack' || player.state === 'air_attack');
      let activeFrames = false;
      
      if (player.state === 'heavy_attack') activeFrames = player.animFrame >= 2 && player.animFrame <= 6; 
      else if (player.state === 'attack') {
          if (player.comboCount === 1 || player.comboCount === 2) activeFrames = player.animFrame === 1 || player.animFrame === 2;
          else if (player.comboCount === 3) activeFrames = player.animFrame >= 1 && player.animFrame <= 5; // Active during the spin
          else if (player.comboCount === 4) activeFrames = player.animFrame >= 5 && player.animFrame <= 10; // The Slam descent
      } 
      else if (player.state === 'air_attack') activeFrames = true;

      if (isAttacking && activeFrames && boss && !boss.isDead) {
          let range = ATTACK_RANGE;
          let damage = ATTACK_DAMAGE;
          let isAir = player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3);
          let isMultiHit = player.state === 'air_attack'; // Only generic air attack is multi-hit now

          if (player.state === 'heavy_attack') {
              range = HEAVY_ATTACK_RANGE;
              damage = HEAVY_ATTACK_DAMAGE;
          } else if (isAir) {
              damage = (player.state === 'attack' && player.comboCount === 3) ? COMBO_3_DAMAGE : AIR_ATTACK_DAMAGE;
              range = ATTACK_RANGE * 1.5;
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
              // Standard Ground Hitbox
              let attackBoxX = player.facingRight ? player.pos.x + player.width : player.pos.x - range;
              let attackBoxW = range;
              let attackBoxY = player.pos.y;
              let attackBoxH = player.height;

              // Special Handling for Slam (Combo 4) and Heavy Attack
              // To fix missing ground targets when in air, and missing targets slightly behind
              if ((player.state === 'attack' && player.comboCount === 4) || player.state === 'heavy_attack') {
                  const slamReach = 250; // Vertical reach downwards
                  attackBoxH += slamReach;
                  
                  const backBuffer = 40; // Hits slightly behind center
                  
                  // Recalculate X/W to include back buffer
                  if (player.facingRight) {
                      // Start slightly behind the player
                      attackBoxX = player.pos.x - backBuffer;
                      attackBoxW = range + player.width + backBuffer;
                  } else {
                      // If facing left, attack goes Left (from pos.x - range) to Right (pos.x + width + back)
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

              // Hit Logic
              let shouldRegisterHit = false;
              if (isMultiHit) {
                   if (player.attackCooldown <= 0) {
                       shouldRegisterHit = true;
                   }
              } else {
                  // For single hits (Combos 1, 2, 3, 4, Heavy), we use the hasDealtDamage flag
                   if (!player.hasDealtDamage) {
                       shouldRegisterHit = true;
                   }
              }

              if (shouldRegisterHit) { 
                 boss.health -= damage;
                 let kForce = 4;
                 if (player.comboCount === 4) kForce = 15;
                 if (player.state === 'heavy_attack') kForce = 25; 
                 
                 boss.vx = player.facingRight ? kForce : -kForce;
                 boss.state = 'hit';
                 boss.animTimer = 0;
                 setBossHealth(boss.health);
                 
                 const pColor = (player.state === 'heavy_attack' || player.comboCount === 4) ? '#ef4444' : '#fbbf24';
                 createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height/2, pColor, 12); 
                 playSound('hit');

                 // --- Hitstop (Timescale Freeze) ---
                 let stopDuration = 10; // Standard snappy feel
                 let shakeInt = 5;

                 if (player.state === 'heavy_attack' || player.comboCount === 4) {
                     stopDuration = 15; // Heavy Impact
                     shakeInt = 20;
                     createParticles(boss.pos.x + boss.width/2, boss.pos.y + boss.height, '#fff', 20, 15);
                 } else if (isMultiHit) {
                     stopDuration = 8; // Stutter Feel for spins
                     shakeInt = 5;
                 }

                 player.hitStop = stopDuration; // Player pauses
                 boss.hitStop = stopDuration + 2; // Boss pauses slightly longer
                 shakeRef.current = shakeInt; // Screen shake

                 setScore(s => s + Math.floor(damage));
                 
                 if (isMultiHit) {
                     // 1 hit per rotation (6 frames * 2 speed = 12 ticks)
                     player.attackCooldown = 18; 
                 } else {
                     // For single hits, mark as dealt
                     player.hasDealtDamage = true;
                 }
              }
          }
      }

      // --- Player Animation State Updates ---
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
        // Normal attack cleanup
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
      
      // Special exit conditions for Multi-hit states
      if (player.state === 'air_attack' || (player.state === 'attack' && player.comboCount === 3)) {
           // Combo 3: Single Rotation (6 frames)
           const limit = player.comboCount === 3 ? 6 : 18;
           if (player.animFrame > limit) { 
               if (player.comboCount === 3) {
                   // Auto-chain to Combo 4 (Slam)
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
                   // For standard air attack, return to idle without chaining to Combo 3/4
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
          if (player.comboCount === 3) animSpeed = 3; // 6 frames for 360 deg
          else if (player.comboCount === 4) animSpeed = 1; 
          else animSpeed = 5;
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
      // --- Active Timeline Ends ---
    }

    // --- 2. Boss Logic ---
    if (boss && !boss.isDead) {
      // Strict Local Timeline
      if (boss.hitStop > 0) {
          boss.hitStop--;
          // SKIP physics/ai/anim
      } else {
        boss.facingRight = player.pos.x > boss.pos.x;
        const distance = Math.abs(player.pos.x - boss.pos.x);
        const PREFERRED_DISTANCE = 220;
        
        if (boss.state !== 'hit') {
            // Jump Smash Attack 
            if (boss.state === 'run' && distance < 250 && distance > 100 && Math.random() < 0.02 && boss.attackCooldown <= 0) {
                boss.state = 'jump_smash'; 
                boss.vy = -15; 
                boss.vx = boss.facingRight ? 8 : -8;
                boss.attackCooldown = 150;
            }
            // Standoff Logic (Transition)
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
                
                if (boss.attackCooldown <= 0 && distance < 120) {
                    boss.state = 'attack';
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
              
              if (boss.attackCooldown <= 0 && distance < 100 && !player.isDead) {
                  boss.state = 'attack';
                  boss.attackCooldown = 100;
                  
                  setTimeout(() => {
                      if(boss.state === 'attack' && !boss.isDead) { 
                          const currDist = Math.abs(player.pos.x - boss.pos.x);
                          const heightDiff = Math.abs(player.pos.y - boss.pos.y);
                          if (currDist < 110 && heightDiff < 50 && player.state !== 'dodge') {
                              player.health -= BOSS_DAMAGE;
                              player.vx = boss.facingRight ? 10 : -10;
                              player.vy = -5;
                              player.state = 'hit';
                              player.animFrame = 0;
                              player.hitStop = 8;
                              boss.hitStop = 6;
                              setPlayerHealth(player.health);
                              shakeRef.current = 10;
                              createParticles(player.pos.x, player.pos.y, '#ef4444', 10);
                              playSound('hit');
                              if (player.health <= 0) {
                                  player.isDead = true;
                                  setGameState(GameState.GAME_OVER);
                              }
                          }
                      }
                  }, 400);
              }
          }
        } else if (boss.state === 'hit') {
            boss.vx *= 0.9;
            if (Math.abs(boss.vx) < 0.1) boss.state = 'idle';
            
            // Hit recovery
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

        boss.animTimer++;
        if (boss.animTimer > 10) {
            boss.animFrame++;
            boss.animTimer = 0;
        }

        if (boss.health <= 0) {
          boss.isDead = true;
          setGameState(GameState.VICTORY);
        }
      }
    }

    // 3. Entity Collision (Only when both active or dodging, but logic handled above)
    if (boss && !boss.isDead && !player.isDead) {
        resolveEntityCollision(player, boss);
    }

    // 4. Particles & Camera (Global Timeline)
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

  // Easing functions for animation smoothness
  const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;
  const easeOutQuad = (t: number) => t * (2 - t);
  const easeInOutQuad = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

  const getAnimSpeed = (p: Entity) => {
      if (p.state === 'run') return 5;
      if (p.state === 'attack') {
          if (p.comboCount === 3) return 3;
          if (p.comboCount === 4) return 1;
          return 5;
      }
      if (p.state === 'heavy_attack') return 2;
      if (p.state === 'dodge') return 3;
      if (p.state === 'hit') return 10;
      if (p.state === 'air_attack') return 2;
      return 8;
  };

  const drawPlayer = (ctx: CanvasRenderingContext2D, p: Entity) => {
    const { width: w, height: h, state, animFrame, comboCount, hitStop } = p;
    
    // Calculate smoothed frame for interpolation (e.g., 1.5 instead of jumping 1 -> 2)
    const speed = getAnimSpeed(p);
    const smoothT = Math.min(1, p.animTimer / speed);
    const smoothFrame = animFrame + smoothT;

    ctx.save();
    
    // Entity Shake
    let shakeX = 0;
    let shakeY = 0;
    if (state === 'hit' && hitStop > 0) {
        shakeX = (Math.random() - 0.5) * 4;
        shakeY = (Math.random() - 0.5) * 4;
    }
    
    // Base Transform (Feet Center)
    ctx.translate(Math.round(p.pos.x + w / 2 + shakeX), Math.round(p.pos.y + h + shakeY));
    if (!p.facingRight) {
        ctx.scale(-1, 1);
    }

    // Define Body Parts Colors
    const cFur = '#8d5c2a';
    const cArmor = '#d97706'; 
    const cCloth = '#1c1917'; 
    const cRed = '#dc2626'; 
    const cSkin = '#fcd34d';
    const cGold = '#fbbf24'; 
    const cStaff = '#262626';

    // --- Render States ---
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
        // Tilt body forward slightly while running
        ctx.save();
        ctx.rotate(0.1); 
        drawRect(ctx, -20 - (cycle===0?4:0), -45 + bob, 12, 25, cRed);
        drawRect(ctx, -9, -38 + bob, 18, 25, cArmor);
        drawRect(ctx, -6, -48 + bob, 14, 12, cFur);
        drawRect(ctx, -5, -46 + bob, 9, 8, cSkin);
        ctx.restore();
        
        drawRect(ctx, -4 + legL, -15, 6, 15, cCloth);
        
        // Staff bob
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
             // Combo 1: Thrust (Lunge)
             // Frames 0 -> 1 (Hit) -> 2 (Recov)
             // Normalized time 0..3
             const t = Math.min(3, smoothFrame);
             
             // Body Lean: 0 -> 0.2 -> 0
             let lean = 0;
             if (t < 1) lean = lerp(0, 0.25, easeOutQuad(t));
             else lean = lerp(0.25, 0, (t-1)/2);

             // Arm Extension: 0 -> 40 -> 0
             let ext = 0;
             if (t < 1.2) ext = lerp(0, 40, easeOutQuad(t/1.2));
             else ext = lerp(40, 0, (t-1.2)/1.8);

             ctx.save();
             ctx.rotate(lean);
             
             // Body
             drawRect(ctx, -15, -45, 15, 20, cRed);
             drawRect(ctx, -9, -35, 18, 25, cArmor);
             drawRect(ctx, -5, -45, 14, 12, cFur);
             drawRect(ctx, -3, -43, 9, 8, cSkin);
             
             // Arm/Staff
             ctx.translate(0, -35); // Shoulder Pivot
             // Slight angle wobble for stab
             ctx.rotate(0.1 - ext * 0.002);
             
             drawRect(ctx, 10 + ext, -2, 70, 6, cGold); // Gold Tip
             drawRect(ctx, -10 + ext, -2, 30, 5, cStaff); // Handle
             
             ctx.restore();
        }
        else if (comboCount === 2) {
             // Combo 2: Sweep (Horizontal Slash)
             // Frames 0 -> 3
             const t = Math.min(3, smoothFrame);
             
             // Body Twist: -0.1 -> 0.2 -> 0
             let twist = lerp(-0.1, 0.3, easeInOutQuad(t/2.5));
             
             // Staff Angle: -2.2 (Back) -> 1.5 (Front)
             const startAngle = -2.2;
             const endAngle = 1.5;
             let angle = lerp(startAngle, endAngle, easeInOutQuad(Math.min(1, t/2)));

             ctx.save();
             ctx.rotate(twist);
             
             drawRect(ctx, -25, -45, 15, 20, cRed);
             drawRect(ctx, -9, -35, 18, 25, cArmor);
             drawRect(ctx, -5, -45, 14, 12, cFur);
             drawRect(ctx, -3, -43, 9, 8, cSkin);
             
             // Arm Pivot
             ctx.translate(0, -35);
             ctx.rotate(angle);
             
             drawRect(ctx, 10, -3, 90, 6, cGold); 
             drawRect(ctx, -20, -3, 30, 6, cStaff);
             
             ctx.restore();
        }
        else if (comboCount === 3) {
            // Combo 3: Forward Spin (360 deg)
            // Frames 0 -> 6 (Speed 3)
            // Smooth angle
            const maxFrame = 6;
            const t = Math.min(maxFrame, smoothFrame);
            const angle = (t / maxFrame) * (Math.PI * 2);

            ctx.translate(0, -35); // Pivot Center Body
            
            // Smear arc
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = cGold;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(0, 0, 85, angle - 1.5, angle, false);
            ctx.arc(0, 0, 70, angle, angle - 1.5, true);
            ctx.fill();
            ctx.globalAlpha = 1.0;
            ctx.globalCompositeOperation = 'source-over';

            ctx.save();
            ctx.rotate(angle); // Rotate the whole body/staff
            
            ctx.globalCompositeOperation = 'lighter';
            ctx.shadowColor = '#fbbf24';
            ctx.shadowBlur = 30; 
            
            ctx.fillStyle = cGold;
            ctx.beginPath();
            ctx.arc(0, 0, 75, 0, Math.PI*2);
            ctx.fill();
            
            ctx.shadowBlur = 0;
            ctx.globalCompositeOperation = 'source-over';

            drawRect(ctx, -70, -4, 140, 8, cStaff);
            drawRect(ctx, -4, -70, 8, 140, cGold);
            ctx.restore();
        }
        // Combo 4: Leveraged Slam
        else if (comboCount === 4) {
            const t = smoothFrame; // 0 to 20

            ctx.save();
            // Body Lean
            let lean = -0.4; 
            if (t > 5) lean = lerp(-0.4, 0.4, easeOutQuad(Math.min(1, (t-5)/5))); // Lean forward during slam
            ctx.rotate(lean); 

            drawRect(ctx, -25, -45, 15, 20, cRed);
            drawRect(ctx, -9, -35, 18, 25, cArmor);
            drawRect(ctx, -5, -45, 14, 12, cFur);
            drawRect(ctx, -3, -43, 9, 8, cSkin);
            ctx.restore();

            ctx.save();
            ctx.translate(0, -35); // Shoulder Pivot
            
            let angle = 0;
            const startAngle = -2.5; // High Back (Continuing from spin)
            const endAngle = 1.8; // Ground
            
            // Phase 1: Windup/Inertia (0-5)
            if (t <= 5) {
                // Interpolate into the hold position instead of snapping
                // Assume start from 0 (upright) if coming from idle, or carry momentum?
                // Constant -2.5 is fine, but maybe add a little "heave"
                const heave = Math.sin(t * 0.5) * 0.1;
                angle = startAngle + heave;
            } 
            // Phase 2: Slam (5-10)
            else if (t <= 10) {
                 // Quadratic ease-in for heavy acceleration
                 const progress = (t - 5) / 5;
                 const ease = progress * progress; 
                 angle = lerp(startAngle, endAngle, ease);
                 
                 // Slam Smear
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
            // Phase 3: Impact Hold (10+)
            else {
                 angle = endAngle;
                 if (t < 14) angle += (Math.random()-0.5)*0.1; // shake
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
        // Continuous Spin
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
        
        // Charging Pose
        ctx.save();
        ctx.transform(1, 0, -0.3, 1, 0, 0); // Skew
        drawRect(ctx, -10, -38, 20, 38, cArmor);
        ctx.restore();
        
        const maxLen = 300;
        let currentLen = 40;
        // Grow smoothly
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
    
    // Screen Shake (Camera)
    const shakeX = (Math.random() - 0.5) * shakeRef.current;
    const shakeY = (Math.random() - 0.5) * shakeRef.current;
    ctx.translate(-cameraXRef.current + shakeX, shakeY);

    // Moon
    ctx.shadowColor = '#f8fafc'; 
    ctx.shadowBlur = 60;
    ctx.fillStyle = '#e5e7eb'; 
    ctx.beginPath();
    ctx.arc(cameraXRef.current + 600, 150, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0; 

    // Floor
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
        if (b.state === 'hit' && b.hitStop > 0) {
            bossShakeX = (Math.random() - 0.5) * 6;
            bossShakeY = (Math.random() - 0.5) * 6;
        }

        ctx.save();
        ctx.translate(bossShakeX, bossShakeY);

        if (b.state === 'hit' && b.hitStop > 0) {
             // Flash white heavily during hit freeze
             ctx.fillStyle = '#fff'; 
             ctx.fillRect(bx, by, b.width, b.height);
        } else if (b.state === 'hit') {
             ctx.fillStyle = '#fff';
             ctx.fillRect(bx, by, b.width, b.height);
        } else {
            const bColor = b.state === 'jump_smash' ? '#7e22ce' : '#581c87';
            drawRect(ctx, bx, by, b.width, b.height, bColor); 
            drawRect(ctx, bx - 10, by + 10, 20, 60, '#3b0764'); 
            drawRect(ctx, bx + b.width - 10, by + 10, 20, 60, '#3b0764');
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
        ctx.shadowBlur = 15; // Increased glow
        ctx.fillRect(part.x, part.y, part.size, part.size);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
    });
    ctx.globalCompositeOperation = 'source-over';

    ctx.restore(); 
    ctx.restore(); 

  }, []);

  useEffect(() => {
    const loop = () => {
      update();
      draw();
      reqRef.current = requestAnimationFrame(loop);
    };

    if (gameState === GameState.PLAYING) {
      loop();
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
