
export enum GameState {
  MENU = 'MENU',
  LOADING = 'LOADING', // Generating story
  PLAYING = 'PLAYING',
  GAME_OVER = 'GAME_OVER',
  VICTORY = 'VICTORY'
}

export interface Position {
  x: number;
  y: number;
}

export interface Entity {
  id: string;
  pos: Position;
  width: number;
  height: number;
  vx: number;
  vy: number;
  color: string;
  health: number;
  maxHealth: number;
  isDead: boolean;
  facingRight: boolean;
  type: 'player' | 'enemy' | 'boss';
  state: 'idle' | 'run' | 'jump' | 'fall' | 'attack' | 'air_attack' | 'heavy_attack' | 'dodge' | 'hit' | 'jump_smash' | 'standoff';
  attackCooldown: number;
  dodgeCooldown: number;
  chargeTimer: number; // For heavy attack calculation
  comboCount: number; // 1, 2, 3, or 4
  comboWindow: number; // Frames allowed to trigger next combo
  animFrame: number;
  animTimer: number;
  hasHitInAir?: boolean; // Tracks if an air attack has connected
  hasDealtDamage?: boolean; // Tracks if the current single-hit attack has registered
  hitStop: number; // Frames to freeze this entity for impact effect
  
  // New Props for Immobilize Mechanic
  spellCooldown?: number;
  isImmobilized?: boolean;
  immobilizeTimer?: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}

export interface LevelData {
  chapterTitle: string;
  introText: string;
  bossName: string;
  bossDescription: string;
}
